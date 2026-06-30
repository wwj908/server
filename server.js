import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { Client } from "ssh2";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const sessions = new Map();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: "70mb" }));
app.use(express.static(path.join(__dirname, "public")));

function makeSessionId() {
  return crypto.randomBytes(24).toString("hex");
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    const error = new Error("Session not found. Please connect again.");
    error.status = 401;
    throw error;
  }
  return session;
}

function execCommand(session, command) {
  return new Promise((resolve, reject) => {
    session.client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      let stdout = "";
      let stderr = "";
      stream
        .on("close", (code) => resolve({ stdout, stderr, code }))
        .on("data", (data) => {
          stdout += data.toString("utf8");
        })
        .stderr.on("data", (data) => {
          stderr += data.toString("utf8");
        });
    });
  });
}

function openSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}

function sftpList(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) reject(err);
      else resolve(list);
    });
  });
}

function sftpStat(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
}

function sftpRead(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    let content = "";
    const stream = sftp.createReadStream(remotePath, { encoding: "utf8" });
    stream.on("data", (chunk) => {
      content += chunk;
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(content));
  });
}

function sftpWrite(sftp, remotePath, content) {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath, { encoding: "utf8" });
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.end(content);
  });
}

function fileType(stats) {
  if (stats.isDirectory()) return "Folder";
  if (stats.isSymbolicLink()) return "Link";
  return "File";
}

function permissions(stats) {
  return `0${(stats.mode & 0o777).toString(8)}`;
}

function normalizeRemotePath(remotePath) {
  if (!remotePath || remotePath.trim() === "") return "/";
  let normalized = path.posix.normalize(remotePath.replaceAll("\\", "/"));
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  return normalized;
}

async function dashboard(session) {
  const commands = {
    hostname: "hostname",
    os: "uname -a",
    uptime: "uptime",
    cpu: "nproc 2>/dev/null; grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2-",
    memory: "free -h 2>/dev/null || vm_stat 2>/dev/null",
    disk: "df -h / 2>/dev/null || df -h",
    processes: "ps -eo pid=,user=,%cpu=,%mem=,comm=,args= --sort=-%cpu | awk '$5 != \"ps\"' | head -200"
  };

  const result = {};
  for (const [name, command] of Object.entries(commands)) {
    const { stdout, stderr } = await execCommand(session, command);
    result[name] = (stdout || stderr).trim();
  }
  return result;
}

app.post("/api/connect", async (req, res, next) => {
  const { host, port: sshPort = 22, username, password } = req.body;
  if (!host || !username || !password) {
    res.status(400).json({ error: "Host, username and password are required." });
    return;
  }

  const client = new Client();
  const sessionId = makeSessionId();

  client
    .on("ready", async () => {
      try {
        const sftp = await openSftp(client);
        sessions.set(sessionId, { client, sftp, host, username });
        res.json({ sessionId, cwd: "/" });
      } catch (error) {
        client.end();
        next(error);
      }
    })
    .on("error", (error) => {
      if (!res.headersSent) next(error);
    })
    .on("close", () => {
      sessions.delete(sessionId);
    })
    .connect({
      host,
      port: Number(sshPort) || 22,
      username,
      password,
      readyTimeout: 10000,
      tryKeyboard: false
    });
});

app.post("/api/disconnect", (req, res, next) => {
  try {
    const session = getSession(req.body.sessionId);
    session.sftp.end();
    session.client.end();
    sessions.delete(req.body.sessionId);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dashboard", async (req, res, next) => {
  try {
    res.json(await dashboard(getSession(req.body.sessionId)));
  } catch (error) {
    next(error);
  }
});

app.post("/api/command", async (req, res, next) => {
  try {
    const { sessionId, command } = req.body;
    if (!command) {
      res.status(400).json({ error: "Command is required." });
      return;
    }
    res.json(await execCommand(getSession(sessionId), command));
  } catch (error) {
    next(error);
  }
});

app.post("/api/process/action", async (req, res, next) => {
  try {
    const { sessionId, action, target, pids = [] } = req.body;
    const session = getSession(sessionId);
    const cleanTarget = String(target || "").replace(/[^A-Za-z0-9@_.:-]/g, "");
    const cleanPids = pids.map((pid) => String(pid).replace(/\D/g, "")).filter(Boolean);

    if (!["start", "stop", "restart"].includes(action)) {
      res.status(400).json({ error: "Unsupported action." });
      return;
    }
    if (!cleanTarget && !cleanPids.length) {
      res.status(400).json({ error: "Process or service name is required." });
      return;
    }

    let command;
    if (action === "stop" && cleanPids.length) {
      command = `kill ${cleanPids.join(" ")}`;
    } else {
      const serviceAction = action === "restart" ? "restart" : action;
      command = `systemctl ${serviceAction} ${cleanTarget} 2>&1 || service ${cleanTarget} ${serviceAction} 2>&1`;
    }

    const result = await execCommand(session, command);
    res.json({ ...result, command });
  } catch (error) {
    next(error);
  }
});

app.post("/api/files/list", async (req, res, next) => {
  try {
    const session = getSession(req.body.sessionId);
    const remotePath = normalizeRemotePath(req.body.path);
    const entries = await sftpList(session.sftp, remotePath);
    const files = entries
      .map((entry) => ({
        name: entry.filename,
        type: fileType(entry.attrs),
        size: entry.attrs.size,
        modified: entry.attrs.mtime ? entry.attrs.mtime * 1000 : null,
        permissions: permissions(entry.attrs)
      }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "Folder" ? -1 : 1));
    res.json({ path: remotePath, files });
  } catch (error) {
    next(error);
  }
});

app.post("/api/files/read", async (req, res, next) => {
  try {
    const session = getSession(req.body.sessionId);
    const remotePath = normalizeRemotePath(req.body.path);
    const stats = await sftpStat(session.sftp, remotePath);
    if (stats.isDirectory()) {
      res.status(400).json({ error: "Cannot open a directory as a file." });
      return;
    }
    if (stats.size > 2 * 1024 * 1024) {
      res.status(413).json({ error: "Only files up to 2 MB can be opened." });
      return;
    }
    res.json({ path: remotePath, content: await sftpRead(session.sftp, remotePath) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/files/write", async (req, res, next) => {
  try {
    const session = getSession(req.body.sessionId);
    const remotePath = normalizeRemotePath(req.body.path);
    await sftpWrite(session.sftp, remotePath, req.body.content ?? "");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/files/upload", async (req, res, next) => {
  try {
    const session = getSession(req.body.sessionId);
    const remotePath = normalizeRemotePath(req.body.path);
    const content = Buffer.from(req.body.contentBase64 || "", "base64");
    if (content.length > 50 * 1024 * 1024) {
      res.status(413).json({ error: "Only files up to 50 MB can be uploaded." });
      return;
    }

    await new Promise((resolve, reject) => {
      const stream = session.sftp.createWriteStream(remotePath);
      stream.on("error", reject);
      stream.on("finish", resolve);
      stream.end(content);
    });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

const server = app.listen(port, () => {
  console.log(`SSH web control panel running at http://localhost:${port}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Set another port, for example: $env:PORT="3002"; npm start`);
    process.exit(1);
  }
  throw error;
});
