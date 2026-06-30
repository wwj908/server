let sessionId = null;
let currentPath = "/";
let currentEditorPath = "";
let promptIndex = 0;
let commandRunning = false;
let selectedProcessGroup = null;
const connectionCacheKey = "ssh-control-connection";

const $ = (id) => document.getElementById(id);

const elements = {
  host: $("host"),
  port: $("port"),
  username: $("username"),
  password: $("password"),
  connect: $("connect"),
  disconnect: $("disconnect"),
  refresh: $("refresh"),
  status: $("status"),
  terminal: $("terminalArea"),
  runLine: $("runLine"),
  processBody: $("processBody"),
  processTarget: $("processTarget"),
  processStart: $("processStart"),
  processStop: $("processStop"),
  processRestart: $("processRestart"),
  fileBody: $("fileBody"),
  filePath: $("filePath"),
  fileUp: $("fileUp"),
  fileOpen: $("fileOpen"),
  fileRefresh: $("fileRefresh"),
  fileUpload: $("fileUpload"),
  fileUploadInput: $("fileUploadInput"),
  editorDialog: $("editorDialog"),
  editorPath: $("editorPath"),
  editorText: $("editorText"),
  saveFile: $("saveFile")
};

let topWindowZ = 10;

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function loadConnectionCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(connectionCacheKey) || "{}");
    elements.host.value = cached.host || "";
    elements.port.value = cached.port || "22";
    elements.username.value = cached.username || "";
    elements.password.value = cached.password || "";
  } catch {
    elements.port.value = "22";
  }
}

function saveConnectionCache() {
  localStorage.setItem(
    connectionCacheKey,
    JSON.stringify({
      host: elements.host.value.trim(),
      port: elements.port.value.trim() || "22",
      username: elements.username.value.trim(),
      password: elements.password.value
    })
  );
}

function setStatus(text) {
  elements.status.textContent = "";
  elements.status.title = text;
  elements.status.setAttribute("aria-label", text);
  elements.status.dataset.state = getStatusState(text);
}

function getStatusState(text) {
  const value = text.toLowerCase();
  if (value.includes("connected")) return "connected";
  if (value.includes("connecting") || value.includes("refreshing") || value.includes("uploading")) return "busy";
  if (value.includes("failed") || value.includes("error") || value.includes("larger")) return "error";
  return "disconnected";
}

function setConnected(connected) {
  elements.connect.disabled = connected;
  elements.disconnect.disabled = !connected;
  elements.refresh.disabled = !connected;
  elements.runLine.disabled = !connected;
  elements.filePath.disabled = !connected;
  elements.fileUp.disabled = !connected;
  elements.fileOpen.disabled = !connected;
  elements.fileRefresh.disabled = !connected;
  elements.fileUpload.disabled = !connected;
  elements.processTarget.disabled = !connected;
  elements.processStart.disabled = !connected || !selectedProcessGroup;
  elements.processStop.disabled = !connected || !selectedProcessGroup;
  elements.processRestart.disabled = !connected || !selectedProcessGroup;
  setStatus(connected ? "Connected" : "Not connected");
}

function appendTerminal(text) {
  elements.terminal.value += text;
  elements.terminal.scrollTop = elements.terminal.scrollHeight;
}

function writePrompt() {
  if (!sessionId || commandRunning) return;
  if (elements.terminal.value && !elements.terminal.value.endsWith("\n")) {
    appendTerminal("\n");
  }
  appendTerminal("$ ");
  promptIndex = elements.terminal.value.length;
  elements.terminal.focus();
}

function currentCommand() {
  return elements.terminal.value.slice(promptIndex).trim();
}

function protectTerminalSelection() {
  if (elements.terminal.selectionStart < promptIndex) {
    elements.terminal.selectionStart = elements.terminal.value.length;
    elements.terminal.selectionEnd = elements.terminal.value.length;
  }
}

function normalizeRemotePath(remotePath) {
  const raw = (remotePath || "/").replaceAll("\\", "/");
  const absolute = raw.startsWith("/") ? raw : `${currentPath.replace(/\/$/, "")}/${raw}`;
  const parts = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function joinRemotePath(base, name) {
  return base === "/" ? `/${name}` : `${base.replace(/\/$/, "")}/${name}`;
}

function formatBytes(size) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(size) || 0;
  for (const unit of units) {
    if (value < 1024 || unit === units.at(-1)) {
      return unit === "B" ? `${value} B` : `${value.toFixed(1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${size} B`;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

function applyDashboard(data) {
  $("hostname").textContent = data.hostname || "-";
  $("os").textContent = data.os || "-";
  $("uptime").textContent = data.uptime || "-";
  $("cpu").textContent = formatCpu(data.cpu || "");
  $("memory").textContent = data.memory || "-";
  $("disk").textContent = data.disk || "-";
  applyProcesses(data.processes || "");
}

function formatCpu(raw) {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "-";
  if (lines.length === 1) return lines[0];
  return `Cores: ${lines[0]}\nModel:${lines[1]}`;
}

function applyProcesses(raw) {
  elements.processBody.innerHTML = "";
  selectedProcessGroup = null;
  setProcessTarget(null);
  const groups = groupProcesses(raw);

  for (const group of groups) {
    const row = document.createElement("tr");
    row.className = "process-group";
    row.dataset.command = group.command;
    row.innerHTML = `
      <td><button class="expand-process" aria-label="Expand ${group.command}">+</button>${group.count > 1 ? "" : group.pid}</td>
      <td>${group.count > 1 ? `${group.users.size} user${group.users.size > 1 ? "s" : ""}` : group.user}</td>
      <td>${group.cpu.toFixed(1)}</td>
      <td>${group.mem.toFixed(1)}</td>
      <td><strong>${group.command}</strong>${group.count > 1 ? `<span class="process-count">${group.count}</span>` : ""}</td>
    `;

    row.addEventListener("click", () => selectProcessGroup(row, group));
    row.querySelector(".expand-process").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleProcessGroup(row, group);
    });
    elements.processBody.append(row);
  }
}

function getDisplayCommand(command, args) {
  if (command !== "java") return command;
  const jarMatch = args.match(/(?:^|\s)-jar\s+("[^"]+"|'[^']+'|\S+)/);
  if (jarMatch) {
    return jarMatch[1].replace(/^["']|["']$/g, "").split("/").pop();
  }
  const looseJarMatch = args.match(/("[^"]+\.jar"|'[^']+\.jar'|\S+\.jar)(?:\s|$)/);
  if (looseJarMatch) {
    return looseJarMatch[1].replace(/^["']|["']$/g, "").split("/").pop();
  }
  const classPathMatch = args.match(/(?:^|\s)(?:-cp|-classpath)\s+("[^"]+"|'[^']+'|\S+)\s+([A-Za-z0-9_.$-]+)/);
  if (classPathMatch) return classPathMatch[2];
  const mainClass = args
    .split(/\s+/)
    .find((part) => /^[A-Za-z_][A-Za-z0-9_.$-]+$/.test(part) && !part.startsWith("java"));
  return mainClass || "java";
}

function groupProcesses(raw) {
  const groups = new Map();
  const lines = raw.split("\n").filter(Boolean);
  for (const line of lines) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, user, cpuText, memText, command, args = command] = match;
    const cpu = Number(cpuText) || 0;
    const mem = Number(memText) || 0;
    const displayCommand = getDisplayCommand(command, args);
    const groupKey = command === "java" ? `${command}:${displayCommand}` : command;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        command: displayCommand,
        serviceCommand: command,
        pid,
        user,
        cpu: 0,
        mem: 0,
        count: 0,
        users: new Set(),
        children: []
      });
    }
    const group = groups.get(groupKey);
    group.cpu += cpu;
    group.mem += mem;
    group.count += 1;
    group.users.add(user);
    group.children.push({ pid, user, cpu, mem, command: displayCommand, args });
  }

  return [...groups.values()].sort((a, b) => b.cpu - a.cpu || b.mem - a.mem || a.command.localeCompare(b.command));
}

function toggleProcessGroup(row, group) {
  const isOpen = row.classList.toggle("open");
  row.querySelector(".expand-process").textContent = isOpen ? "-" : "+";
  if (!isOpen) {
    document.querySelectorAll(`tr[data-parent="${CSS.escape(group.command)}"]`).forEach((child) => child.remove());
    return;
  }

  let anchor = row;
  for (const child of group.children) {
    const childRow = document.createElement("tr");
    childRow.className = "process-child";
    childRow.dataset.parent = group.command;
    childRow.innerHTML = `
      <td>${child.pid}</td>
      <td>${child.user}</td>
      <td>${child.cpu.toFixed(1)}</td>
      <td>${child.mem.toFixed(1)}</td>
      <td title="${child.args.replaceAll('"', "&quot;")}">${child.command}</td>
    `;
    anchor.after(childRow);
    anchor = childRow;
  }
}

function setProcessTarget(group) {
  selectedProcessGroup = group;
  elements.processTarget.value = group ? group.command : "";
  const enabled = Boolean(sessionId && group);
  elements.processStart.disabled = !enabled;
  elements.processStop.disabled = !enabled;
  elements.processRestart.disabled = !enabled;
}

function selectProcessGroup(row, group) {
  document.querySelectorAll(".process-group.selected").forEach((item) => item.classList.remove("selected"));
  row.classList.add("selected");
  setProcessTarget(group);
}

async function runProcessAction(action) {
  const target = elements.processTarget.value.trim();
  if (!sessionId || !target) return;
  const pids = selectedProcessGroup?.children.map((child) => child.pid) || [];
  const label = action === "restart" ? "restart" : action;
  if (!confirm(`Confirm ${label}: ${target}?`)) return;

  setStatus(`${label} ${target}...`);
  try {
    const result = await api("/api/process/action", {
      sessionId,
      action,
      target,
      pids
    });
    appendTerminal(`\n$ ${result.command}\n${result.stdout || ""}${result.stderr || ""}`);
    await refreshDashboard();
  } catch (error) {
    setStatus(error.message);
    appendTerminal(`\nProcess action failed: ${error.message}\n`);
  }
}

async function refreshDashboard() {
  if (!sessionId) return;
  setStatus("Refreshing...");
  try {
    applyDashboard(await api("/api/dashboard", { sessionId }));
    setStatus("Connected");
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadFiles(remotePath) {
  if (!sessionId) return;
  const path = normalizeRemotePath(remotePath);
  const data = await api("/api/files/list", { sessionId, path });
  currentPath = data.path;
  elements.filePath.value = currentPath;
  elements.fileBody.innerHTML = "";
  for (const file of data.files) {
    const row = document.createElement("tr");
    row.dataset.kind = file.type;
    row.innerHTML = `<td>${file.name}</td><td>${file.type}</td><td>${file.type === "Folder" ? "" : formatBytes(file.size)}</td><td>${formatDate(file.modified)}</td><td>${file.permissions}</td>`;
    row.addEventListener("dblclick", () => openFileItem(file));
    elements.fileBody.append(row);
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",", 2)[1] : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Cannot read local file."));
    reader.readAsDataURL(file);
  });
}

async function uploadSelectedFile() {
  const file = elements.fileUploadInput.files?.[0];
  elements.fileUploadInput.value = "";
  if (!file || !sessionId) return;
  if (file.size > 50 * 1024 * 1024) {
    setStatus("Upload failed: file is larger than 50 MB");
    return;
  }

  const remotePath = joinRemotePath(currentPath, file.name);
  setStatus(`Uploading ${file.name}...`);
  try {
    const contentBase64 = await readFileAsBase64(file);
    await api("/api/files/upload", {
      sessionId,
      path: remotePath,
      contentBase64
    });
    setStatus(`Uploaded ${file.name}`);
    await loadFiles(currentPath);
  } catch (error) {
    setStatus(error.message);
  }
}

async function openFileItem(file) {
  const remotePath = joinRemotePath(currentPath, file.name);
  if (file.type === "Folder") {
    await loadFiles(remotePath);
    return;
  }
  const data = await api("/api/files/read", { sessionId, path: remotePath });
  currentEditorPath = data.path;
  elements.editorPath.textContent = data.path;
  elements.editorText.value = data.content;
  elements.editorDialog.showModal();
}

async function runCurrentCommand() {
  const command = currentCommand();
  if (!sessionId || !command || commandRunning) return;
  commandRunning = true;
  elements.runLine.disabled = true;
  appendTerminal("\n");
  try {
    const result = await api("/api/command", { sessionId, command });
    appendTerminal(result.stdout || "");
    appendTerminal(result.stderr || "");
  } catch (error) {
    appendTerminal(`Command failed: ${error.message}\n`);
  } finally {
    commandRunning = false;
    elements.runLine.disabled = false;
    writePrompt();
  }
}

function focusWindow(windowId) {
  const win = $(windowId);
  if (!win) return;
  win.classList.add("active", "focused");
  win.style.zIndex = String(++topWindowZ);
  document.querySelectorAll(".vm-window").forEach((item) => {
    if (item !== win) item.classList.remove("focused");
  });
  document.querySelectorAll(`[data-window="${windowId}"].task-button`).forEach((button) => {
    button.classList.add("active");
  });
}

function toggleTaskWindow(windowId) {
  const win = $(windowId);
  if (!win) return;
  if (win.classList.contains("active") && win.classList.contains("focused")) {
    minimizeWindow(windowId);
    return;
  }
  focusWindow(windowId);
}

function minimizeWindow(windowId) {
  const win = $(windowId);
  if (!win) return;
  win.classList.remove("active", "focused");
  document.querySelectorAll(`[data-window="${windowId}"].task-button`).forEach((button) => {
    button.classList.remove("active");
  });
}

function clampWindowPosition(left, top, win) {
  const margin = 8;
  const taskbarHeight = 72;
  const maxLeft = Math.max(margin, window.innerWidth - win.offsetWidth - margin);
  const maxTop = Math.max(margin, window.innerHeight - win.offsetHeight - taskbarHeight);
  return {
    left: Math.min(Math.max(left, margin), maxLeft),
    top: Math.min(Math.max(top, margin), maxTop)
  };
}

function enableWindowDrag(win) {
  const titlebar = win.querySelector(".window-titlebar");
  if (!titlebar) return;

  titlebar.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    event.preventDefault();
    focusWindow(win.id);

    const rect = win.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;

    titlebar.setPointerCapture(event.pointerId);
    win.classList.add("dragging");

    const moveWindow = (moveEvent) => {
      const next = clampWindowPosition(moveEvent.clientX - offsetX, moveEvent.clientY - offsetY, win);
      win.style.left = `${next.left}px`;
      win.style.top = `${next.top}px`;
      win.style.removeProperty("--x");
      win.style.removeProperty("--y");
    };

    const stopDrag = () => {
      win.classList.remove("dragging");
      titlebar.removeEventListener("pointermove", moveWindow);
      titlebar.removeEventListener("pointerup", stopDrag);
      titlebar.removeEventListener("pointercancel", stopDrag);
    };

    titlebar.addEventListener("pointermove", moveWindow);
    titlebar.addEventListener("pointerup", stopDrag);
    titlebar.addEventListener("pointercancel", stopDrag);
  });
}

document.querySelectorAll("[data-window]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.classList.contains("task-button")) {
      toggleTaskWindow(button.dataset.window);
      return;
    }
    focusWindow(button.dataset.window);
  });
});

document.querySelectorAll(".window-minimize").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    minimizeWindow(button.dataset.window);
  });
});

document.querySelectorAll(".vm-window").forEach((win) => {
  win.addEventListener("pointerdown", () => focusWindow(win.id));
  enableWindowDrag(win);
});

function updateTaskbarClock() {
  const clock = $("taskbarClock");
  if (!clock) return;
  clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

updateTaskbarClock();
setInterval(updateTaskbarClock, 30000);

elements.connect.addEventListener("click", async () => {
  setStatus("Connecting...");
  elements.connect.disabled = true;
  appendTerminal(`Connecting to ${elements.username.value}@${elements.host.value}:${elements.port.value || 22}...\n`);
  try {
    const data = await api("/api/connect", {
      host: elements.host.value.trim(),
      port: elements.port.value.trim() || 22,
      username: elements.username.value.trim(),
      password: elements.password.value
    });
    saveConnectionCache();
    sessionId = data.sessionId;
    currentPath = data.cwd || "/";
    setConnected(true);
    appendTerminal("Connected.\n");
    writePrompt();
    await Promise.all([refreshDashboard(), loadFiles(currentPath)]);
  } catch (error) {
    sessionId = null;
    setConnected(false);
    appendTerminal(`Connection failed: ${error.message}\n`);
  }
});

elements.disconnect.addEventListener("click", async () => {
  if (sessionId) {
    try {
      await api("/api/disconnect", { sessionId });
    } catch {
      // The session may already be gone on the server.
    }
  }
  sessionId = null;
  setConnected(false);
  appendTerminal("Disconnected.\n");
});

elements.refresh.addEventListener("click", refreshDashboard);
elements.runLine.addEventListener("click", runCurrentCommand);
elements.processStart.addEventListener("click", () => runProcessAction("start"));
elements.processStop.addEventListener("click", () => runProcessAction("stop"));
elements.processRestart.addEventListener("click", () => runProcessAction("restart"));
elements.processTarget.addEventListener("input", () => {
  const target = elements.processTarget.value.trim();
  selectedProcessGroup = target
    ? { command: target, children: [] }
    : null;
  setConnected(Boolean(sessionId));
});

elements.terminal.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runCurrentCommand();
    return;
  }
  if (["Backspace", "ArrowLeft"].includes(event.key) && elements.terminal.selectionStart <= promptIndex) {
    event.preventDefault();
    elements.terminal.selectionStart = promptIndex;
    elements.terminal.selectionEnd = promptIndex;
    return;
  }
  if (!event.ctrlKey && !event.metaKey && event.key.length === 1) {
    protectTerminalSelection();
  }
});

elements.terminal.addEventListener("paste", () => {
  setTimeout(protectTerminalSelection, 0);
});

elements.fileUp.addEventListener("click", () => {
  const parent = currentPath === "/" ? "/" : currentPath.replace(/\/$/, "").split("/").slice(0, -1).join("/") || "/";
  loadFiles(parent).catch((error) => setStatus(error.message));
});

elements.fileOpen.addEventListener("click", () => {
  loadFiles(elements.filePath.value).catch((error) => setStatus(error.message));
});

elements.filePath.addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadFiles(elements.filePath.value).catch((error) => setStatus(error.message));
});

elements.fileRefresh.addEventListener("click", () => {
  loadFiles(currentPath).catch((error) => setStatus(error.message));
});

elements.fileUpload.addEventListener("click", () => {
  elements.fileUploadInput.click();
});

elements.fileUploadInput.addEventListener("change", uploadSelectedFile);

elements.saveFile.addEventListener("click", async () => {
  try {
    await api("/api/files/write", {
      sessionId,
      path: currentEditorPath,
      content: elements.editorText.value
    });
    setStatus("File saved");
    await loadFiles(currentPath);
  } catch (error) {
    setStatus(error.message);
  }
});

for (const input of [elements.host, elements.port, elements.username, elements.password]) {
  input.addEventListener("input", saveConnectionCache);
}

loadConnectionCache();
