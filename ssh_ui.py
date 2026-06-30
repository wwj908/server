import queue
import stat
import threading
import tkinter as tk
from tkinter import messagebox, scrolledtext, ttk

import paramiko


class SSHControlPanel(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("SSH Server Control Panel")
        self.geometry("1080x680")
        self.minsize(920, 580)

        self.client: paramiko.SSHClient | None = None
        self.sftp: paramiko.SFTPClient | None = None
        self.output_queue: queue.Queue[tuple[str, object]] = queue.Queue()

        self.host_var = tk.StringVar()
        self.port_var = tk.StringVar(value="22")
        self.username_var = tk.StringVar()
        self.password_var = tk.StringVar()
        self.status_var = tk.StringVar(value="Not connected")
        self.prompt = "$ "
        self.prompt_mark = "1.0"
        self.command_running = False

        self.hostname_var = tk.StringVar(value="-")
        self.os_var = tk.StringVar(value="-")
        self.uptime_var = tk.StringVar(value="-")
        self.cpu_var = tk.StringVar(value="-")
        self.memory_var = tk.StringVar(value="-")
        self.disk_var = tk.StringVar(value="-")
        self.remote_path_var = tk.StringVar(value="/")
        self.current_remote_path = "/"

        self._build_ui()
        self.after(100, self._flush_output_queue)

    def _build_ui(self) -> None:
        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)

        connection = ttk.LabelFrame(self, text="Server Login", padding=12)
        connection.grid(row=0, column=0, sticky="ew", padx=14, pady=(14, 8))
        connection.columnconfigure(1, weight=1)
        connection.columnconfigure(3, weight=1)

        ttk.Label(connection, text="IP / Host").grid(row=0, column=0, sticky="w")
        ttk.Entry(connection, textvariable=self.host_var).grid(
            row=0, column=1, sticky="ew", padx=(8, 14)
        )

        ttk.Label(connection, text="Port").grid(row=0, column=2, sticky="w")
        ttk.Entry(connection, textvariable=self.port_var, width=8).grid(
            row=0, column=3, sticky="ew", padx=(8, 0)
        )

        ttk.Label(connection, text="Username").grid(row=1, column=0, sticky="w", pady=(10, 0))
        ttk.Entry(connection, textvariable=self.username_var).grid(
            row=1, column=1, sticky="ew", padx=(8, 14), pady=(10, 0)
        )

        ttk.Label(connection, text="Password").grid(row=1, column=2, sticky="w", pady=(10, 0))
        ttk.Entry(connection, textvariable=self.password_var, show="*").grid(
            row=1, column=3, sticky="ew", padx=(8, 0), pady=(10, 0)
        )

        buttons = ttk.Frame(connection)
        buttons.grid(row=2, column=0, columnspan=4, sticky="ew", pady=(12, 0))
        buttons.columnconfigure(3, weight=1)

        self.connect_button = ttk.Button(buttons, text="Connect", command=self.connect)
        self.connect_button.grid(row=0, column=0, sticky="w")

        self.disconnect_button = ttk.Button(
            buttons, text="Disconnect", command=self.disconnect, state="disabled"
        )
        self.disconnect_button.grid(row=0, column=1, sticky="w", padx=(8, 0))

        self.refresh_button = ttk.Button(
            buttons, text="Refresh", command=self.refresh_dashboard, state="disabled"
        )
        self.refresh_button.grid(row=0, column=2, sticky="w", padx=(8, 0))

        ttk.Label(buttons, textvariable=self.status_var).grid(row=0, column=3, sticky="e")

        notebook = ttk.Notebook(self)
        notebook.grid(row=1, column=0, sticky="nsew", padx=14, pady=(0, 14))

        overview = ttk.Frame(notebook, padding=12)
        processes = ttk.Frame(notebook, padding=12)
        files = ttk.Frame(notebook, padding=12)
        terminal = ttk.Frame(notebook, padding=12)
        notebook.add(overview, text="Overview")
        notebook.add(processes, text="Processes")
        notebook.add(files, text="Files")
        notebook.add(terminal, text="Terminal")

        self._build_overview_tab(overview)
        self._build_processes_tab(processes)
        self._build_files_tab(files)
        self._build_terminal_tab(terminal)

    def _build_overview_tab(self, parent: ttk.Frame) -> None:
        parent.columnconfigure(0, weight=1)
        parent.columnconfigure(1, weight=1)

        fields = [
            ("Hostname", self.hostname_var),
            ("Operating System", self.os_var),
            ("Uptime / Load", self.uptime_var),
            ("CPU", self.cpu_var),
            ("Memory", self.memory_var),
            ("Disk", self.disk_var),
        ]

        for index, (label, variable) in enumerate(fields):
            frame = ttk.LabelFrame(parent, text=label, padding=12)
            frame.grid(
                row=index // 2,
                column=index % 2,
                sticky="nsew",
                padx=(0, 10) if index % 2 == 0 else (0, 0),
                pady=(0, 10),
            )
            frame.columnconfigure(0, weight=1)
            ttk.Label(frame, textvariable=variable, wraplength=460, justify="left").grid(
                row=0, column=0, sticky="nw"
            )

    def _build_processes_tab(self, parent: ttk.Frame) -> None:
        parent.columnconfigure(0, weight=1)
        parent.rowconfigure(0, weight=1)

        columns = ("pid", "user", "cpu", "mem", "command")
        self.process_tree = ttk.Treeview(parent, columns=columns, show="headings", height=18)
        self.process_tree.heading("pid", text="PID")
        self.process_tree.heading("user", text="USER")
        self.process_tree.heading("cpu", text="CPU %")
        self.process_tree.heading("mem", text="MEM %")
        self.process_tree.heading("command", text="COMMAND")

        self.process_tree.column("pid", width=90, anchor="e", stretch=False)
        self.process_tree.column("user", width=130, stretch=False)
        self.process_tree.column("cpu", width=80, anchor="e", stretch=False)
        self.process_tree.column("mem", width=80, anchor="e", stretch=False)
        self.process_tree.column("command", width=620)

        scrollbar = ttk.Scrollbar(parent, orient="vertical", command=self.process_tree.yview)
        self.process_tree.configure(yscrollcommand=scrollbar.set)
        self.process_tree.grid(row=0, column=0, sticky="nsew")
        scrollbar.grid(row=0, column=1, sticky="ns")

    def _build_files_tab(self, parent: ttk.Frame) -> None:
        parent.columnconfigure(0, weight=1)
        parent.rowconfigure(1, weight=1)

        toolbar = ttk.Frame(parent)
        toolbar.grid(row=0, column=0, sticky="ew", pady=(0, 10))
        toolbar.columnconfigure(1, weight=1)

        self.file_up_button = ttk.Button(toolbar, text="Up", command=self.open_parent_dir, state="disabled")
        self.file_up_button.grid(row=0, column=0, padx=(0, 8))

        self.path_entry = ttk.Entry(toolbar, textvariable=self.remote_path_var, state="disabled")
        self.path_entry.grid(row=0, column=1, sticky="ew")
        self.path_entry.bind("<Return>", lambda _event: self.open_path_from_entry())

        self.file_open_button = ttk.Button(
            toolbar, text="Open", command=self.open_path_from_entry, state="disabled"
        )
        self.file_open_button.grid(row=0, column=2, padx=(8, 0))

        self.file_refresh_button = ttk.Button(
            toolbar, text="Refresh", command=self.refresh_files, state="disabled"
        )
        self.file_refresh_button.grid(row=0, column=3, padx=(8, 0))

        columns = ("name", "type", "size", "modified", "permissions")
        self.file_tree = ttk.Treeview(parent, columns=columns, show="headings", height=18)
        self.file_tree.heading("name", text="Name")
        self.file_tree.heading("type", text="Type")
        self.file_tree.heading("size", text="Size")
        self.file_tree.heading("modified", text="Modified")
        self.file_tree.heading("permissions", text="Permissions")
        self.file_tree.column("name", width=360)
        self.file_tree.column("type", width=90, stretch=False)
        self.file_tree.column("size", width=110, anchor="e", stretch=False)
        self.file_tree.column("modified", width=170, stretch=False)
        self.file_tree.column("permissions", width=120, stretch=False)
        self.file_tree.bind("<Double-1>", lambda _event: self.open_selected_file_item())

        scrollbar = ttk.Scrollbar(parent, orient="vertical", command=self.file_tree.yview)
        self.file_tree.configure(yscrollcommand=scrollbar.set)
        self.file_tree.grid(row=1, column=0, sticky="nsew")
        scrollbar.grid(row=1, column=1, sticky="ns")

    def _build_terminal_tab(self, parent: ttk.Frame) -> None:
        parent.columnconfigure(0, weight=1)
        parent.rowconfigure(0, weight=1)

        self.output = scrolledtext.ScrolledText(
            parent,
            wrap="word",
            state="normal",
            bg="#111827",
            fg="#e5e7eb",
            insertbackground="#e5e7eb",
            font=("Consolas", 10),
            undo=False,
        )
        self.output.grid(row=0, column=0, sticky="nsew")
        self.output.bind("<Return>", self._handle_terminal_enter)
        self.output.bind("<BackSpace>", self._protect_prompt_area)
        self.output.bind("<Delete>", self._protect_prompt_area)
        self.output.bind("<Left>", self._protect_prompt_area)
        self.output.bind("<Home>", self._move_to_prompt_start)
        self.output.bind("<KeyPress>", self._handle_terminal_keypress)
        self.output.bind("<Button-1>", self._focus_terminal)
        self.output.bind("<Control-v>", self._paste_terminal)
        self.output.bind("<Control-V>", self._paste_terminal)

        command_bar = ttk.Frame(parent)
        command_bar.grid(row=1, column=0, sticky="ew", pady=(10, 0))
        command_bar.columnconfigure(0, weight=1)

        ttk.Label(command_bar, text="Type or paste commands directly in the terminal above.").grid(
            row=0, column=0, sticky="w"
        )

        self.run_button = ttk.Button(
            command_bar, text="Run Current Line", command=self.run_command, state="disabled"
        )
        self.run_button.grid(row=0, column=1, padx=(8, 0))

    def connect(self) -> None:
        host = self.host_var.get().strip()
        username = self.username_var.get().strip()
        password = self.password_var.get()
        port_text = self.port_var.get().strip() or "22"

        if not host or not username or not password:
            messagebox.showwarning("Missing Info", "Please enter IP/host, username and password.")
            return

        try:
            port = int(port_text)
        except ValueError:
            messagebox.showwarning("Invalid Port", "Port must be a number.")
            return

        self._set_connecting(True)
        self._append_output(f"Connecting to {username}@{host}:{port}...\n")

        thread = threading.Thread(
            target=self._connect_worker,
            args=(host, port, username, password),
            daemon=True,
        )
        thread.start()

    def _connect_worker(self, host: str, port: int, username: str, password: str) -> None:
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(
                hostname=host,
                port=port,
                username=username,
                password=password,
                timeout=10,
                look_for_keys=False,
                allow_agent=False,
            )
            self.sftp = client.open_sftp()
            self.client = client
            self.output_queue.put(("connected", None))
            self.output_queue.put(("terminal", "Connected.\n"))
            self.output_queue.put(("prompt", None))
            self.output_queue.put(("files_path", self._exec_text("pwd") or "/"))
            self.refresh_dashboard()
        except paramiko.AuthenticationException:
            self.output_queue.put(("disconnected", None))
            self.output_queue.put(("terminal", "Connection failed: username or password is incorrect.\n"))
        except Exception as exc:
            self.output_queue.put(("disconnected", None))
            self.output_queue.put(("terminal", f"Connection failed: {exc}\n"))

    def disconnect(self) -> None:
        if self.sftp:
            self.sftp.close()
            self.sftp = None
        if self.client:
            self.client.close()
            self.client = None
        self._clear_dashboard()
        self._clear_files()
        self._set_connected(False)
        self._append_output("Disconnected.\n")

    def refresh_dashboard(self) -> None:
        if not self.client:
            return

        self.refresh_button.configure(state="disabled")
        self.status_var.set("Refreshing...")
        thread = threading.Thread(target=self._dashboard_worker, daemon=True)
        thread.start()

    def _dashboard_worker(self) -> None:
        try:
            commands = {
                "hostname": "hostname",
                "os": "uname -a",
                "uptime": "uptime",
                "cpu": "nproc 2>/dev/null; grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2-",
                "memory": "free -h 2>/dev/null || vm_stat 2>/dev/null",
                "disk": "df -h / 2>/dev/null || df -h",
                "processes": "ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu | head -31",
            }
            result = {name: self._exec_text(command) for name, command in commands.items()}
            self.output_queue.put(("dashboard", result))
        except Exception as exc:
            self.output_queue.put(("terminal", f"Refresh failed: {exc}\n"))
        finally:
            self.output_queue.put(("refresh_done", None))

    def _exec_text(self, command: str) -> str:
        if not self.client:
            return ""
        _stdin, stdout, stderr = self.client.exec_command(command)
        output = stdout.read().decode("utf-8", errors="replace").strip()
        error = stderr.read().decode("utf-8", errors="replace").strip()
        return output or error

    def _apply_dashboard(self, data: dict[str, str]) -> None:
        self.hostname_var.set(data.get("hostname") or "-")
        self.os_var.set(data.get("os") or "-")
        self.uptime_var.set(data.get("uptime") or "-")
        self.cpu_var.set(self._format_cpu(data.get("cpu", "")))
        self.memory_var.set(data.get("memory") or "-")
        self.disk_var.set(data.get("disk") or "-")
        self._apply_processes(data.get("processes", ""))

    def _format_cpu(self, raw: str) -> str:
        lines = [line.strip() for line in raw.splitlines() if line.strip()]
        if not lines:
            return "-"
        if len(lines) == 1:
            return lines[0]
        return f"Cores: {lines[0]}\nModel:{lines[1]}"

    def _apply_processes(self, raw: str) -> None:
        for item in self.process_tree.get_children():
            self.process_tree.delete(item)

        lines = [line for line in raw.splitlines() if line.strip()]
        for line in lines[1:]:
            parts = line.split(None, 4)
            if len(parts) < 5:
                continue
            self.process_tree.insert("", "end", values=parts)

    def _clear_dashboard(self) -> None:
        for variable in (
            self.hostname_var,
            self.os_var,
            self.uptime_var,
            self.cpu_var,
            self.memory_var,
            self.disk_var,
        ):
            variable.set("-")
        for item in self.process_tree.get_children():
            self.process_tree.delete(item)

    def refresh_files(self) -> None:
        if not self.sftp:
            return
        self._load_remote_dir(self.current_remote_path)

    def open_parent_dir(self) -> None:
        path = self.current_remote_path.rstrip("/")
        parent = "/" if not path or "/" not in path else path.rsplit("/", 1)[0] or "/"
        self._load_remote_dir(parent)

    def open_path_from_entry(self) -> None:
        path = self.remote_path_var.get().strip() or "/"
        self._open_remote_path(path)

    def open_selected_file_item(self) -> None:
        selection = self.file_tree.selection()
        if not selection:
            return
        item = selection[0]
        name = str(self.file_tree.item(item, "values")[0])
        path = self._join_remote_path(self.current_remote_path, name)
        self._open_remote_path(path)

    def _open_remote_path(self, path: str) -> None:
        if not self.sftp:
            return
        try:
            attrs = self.sftp.stat(path)
        except OSError as exc:
            messagebox.showerror("Open Failed", f"Cannot open path:\n{exc}")
            return
        if stat.S_ISDIR(attrs.st_mode or 0):
            self._load_remote_dir(path)
        else:
            self._open_remote_file(path)

    def _load_remote_dir(self, path: str) -> None:
        if not self.sftp:
            return
        try:
            entries = self.sftp.listdir_attr(path)
        except OSError as exc:
            messagebox.showerror("Open Failed", f"Cannot open directory:\n{exc}")
            return

        self.current_remote_path = self._normalize_remote_path(path)
        self.remote_path_var.set(self.current_remote_path)
        for item in self.file_tree.get_children():
            self.file_tree.delete(item)

        entries.sort(key=lambda attr: (not stat.S_ISDIR(attr.st_mode or 0), attr.filename.lower()))
        for attr in entries:
            is_dir = stat.S_ISDIR(attr.st_mode or 0)
            values = (
                attr.filename,
                "Folder" if is_dir else "File",
                "" if is_dir else self._format_size(attr.st_size or 0),
                self._format_time(attr.st_mtime),
                stat.filemode(attr.st_mode or 0),
            )
            self.file_tree.insert("", "end", values=values)

    def _open_remote_file(self, path: str) -> None:
        if not self.sftp:
            return
        try:
            attrs = self.sftp.stat(path)
            size = attrs.st_size or 0
            if size > 2 * 1024 * 1024:
                messagebox.showwarning("File Too Large", "Only files up to 2 MB can be opened here.")
                return
            with self.sftp.open(path, "rb") as remote_file:
                data = remote_file.read()
            content = data.decode("utf-8", errors="replace")
        except OSError as exc:
            messagebox.showerror("Open Failed", f"Cannot read file:\n{exc}")
            return

        editor = tk.Toplevel(self)
        editor.title(path)
        editor.geometry("900x620")
        editor.minsize(720, 460)
        editor.columnconfigure(0, weight=1)
        editor.rowconfigure(0, weight=1)

        text = scrolledtext.ScrolledText(editor, wrap="none", font=("Consolas", 10), undo=True)
        text.grid(row=0, column=0, sticky="nsew")
        text.insert("1.0", content)

        actions = ttk.Frame(editor, padding=10)
        actions.grid(row=1, column=0, sticky="ew")
        actions.columnconfigure(0, weight=1)
        ttk.Label(actions, text=path).grid(row=0, column=0, sticky="w")
        ttk.Button(actions, text="Save", command=lambda: self._save_remote_file(path, text)).grid(
            row=0, column=1, padx=(8, 0)
        )
        ttk.Button(actions, text="Close", command=editor.destroy).grid(row=0, column=2, padx=(8, 0))

    def _save_remote_file(self, path: str, text: scrolledtext.ScrolledText) -> None:
        if not self.sftp:
            messagebox.showwarning("Not Connected", "Please connect to a server first.")
            return
        try:
            content = text.get("1.0", "end-1c").encode("utf-8")
            with self.sftp.open(path, "wb") as remote_file:
                remote_file.write(content)
            messagebox.showinfo("Saved", "File saved to server.")
            self.refresh_files()
        except OSError as exc:
            messagebox.showerror("Save Failed", f"Cannot save file:\n{exc}")

    def _clear_files(self) -> None:
        self.current_remote_path = "/"
        self.remote_path_var.set("/")
        for item in self.file_tree.get_children():
            self.file_tree.delete(item)

    def _set_files_enabled(self, enabled: bool) -> None:
        state = "normal" if enabled else "disabled"
        self.file_up_button.configure(state=state)
        self.path_entry.configure(state=state)
        self.file_open_button.configure(state=state)
        self.file_refresh_button.configure(state=state)

    def _join_remote_path(self, base: str, name: str) -> str:
        return f"/{name}" if base == "/" else f"{base.rstrip('/')}/{name}"

    def _normalize_remote_path(self, path: str) -> str:
        if not path.startswith("/"):
            path = f"{self.current_remote_path.rstrip('/')}/{path}"
        parts = []
        for part in path.split("/"):
            if not part or part == ".":
                continue
            if part == "..":
                if parts:
                    parts.pop()
            else:
                parts.append(part)
        return "/" + "/".join(parts)

    def _format_size(self, size: int) -> str:
        units = ["B", "KB", "MB", "GB", "TB"]
        value = float(size)
        for unit in units:
            if value < 1024 or unit == units[-1]:
                return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
            value /= 1024
        return f"{size} B"

    def _format_time(self, timestamp: int | None) -> str:
        if not timestamp:
            return "-"
        from datetime import datetime

        return datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d %H:%M:%S")

    def run_command(self) -> None:
        command = self._get_current_command()
        if not command:
            return
        if not self.client:
            messagebox.showwarning("Not Connected", "Please connect to a server first.")
            return

        self.command_running = True
        self._append_output("\n")
        self.run_button.configure(state="disabled")

        thread = threading.Thread(target=self._command_worker, args=(command,), daemon=True)
        thread.start()

    def _command_worker(self, command: str) -> None:
        try:
            if not self.client:
                self.output_queue.put(("terminal", "Not connected.\n"))
                return

            _stdin, stdout, stderr = self.client.exec_command(command)
            output = stdout.read().decode("utf-8", errors="replace")
            error = stderr.read().decode("utf-8", errors="replace")

            if output:
                self.output_queue.put(("terminal", output if output.endswith("\n") else f"{output}\n"))
            if error:
                self.output_queue.put(("terminal", error if error.endswith("\n") else f"{error}\n"))
        except Exception as exc:
            self.output_queue.put(("terminal", f"Command failed: {exc}\n"))
        finally:
            self.output_queue.put(("command_done", None))

    def _set_connecting(self, connecting: bool) -> None:
        self.connect_button.configure(state="disabled" if connecting else "normal")
        self.disconnect_button.configure(state="disabled")
        self.refresh_button.configure(state="disabled")
        self._set_files_enabled(False)
        self.run_button.configure(state="disabled")
        self.status_var.set("Connecting..." if connecting else "Not connected")

    def _set_connected(self, connected: bool) -> None:
        self.connect_button.configure(state="disabled" if connected else "normal")
        self.disconnect_button.configure(state="normal" if connected else "disabled")
        self.refresh_button.configure(state="normal" if connected else "disabled")
        self._set_files_enabled(connected)
        self.run_button.configure(state="normal" if connected else "disabled")
        self.status_var.set("Connected" if connected else "Not connected")
        if connected:
            self.output.focus_set()

    def _append_output(self, text: str) -> None:
        self.output.insert("end", text)
        self.output.see("end")

    def _write_prompt(self) -> None:
        if not self.client or self.command_running:
            return
        if self.output.index("end-1c") != "1.0":
            last_char = self.output.get("end-2c", "end-1c")
            if last_char != "\n":
                self.output.insert("end", "\n")
        self.output.insert("end", self.prompt)
        self.prompt_mark = self.output.index("end-1c")
        self.output.mark_set("insert", "end-1c")
        self.output.see("end")
        self.output.focus_set()

    def _get_current_command(self) -> str:
        return self.output.get(self.prompt_mark, "end-1c").strip()

    def _handle_terminal_enter(self, _event: tk.Event) -> str:
        if self.client and not self.command_running:
            self.run_command()
        return "break"

    def _handle_terminal_keypress(self, event: tk.Event) -> str | None:
        if event.keysym in {
            "Return",
            "BackSpace",
            "Delete",
            "Left",
            "Right",
            "Home",
            "End",
            "Up",
            "Down",
            "Prior",
            "Next",
        }:
            return None
        if self.command_running or not self.client:
            return "break"
        if self.output.compare("insert", "<", self.prompt_mark):
            self.output.mark_set("insert", "end-1c")
        return None

    def _protect_prompt_area(self, _event: tk.Event) -> str | None:
        if self.output.compare("insert", "<=", self.prompt_mark):
            self.output.mark_set("insert", "end-1c")
            return "break"
        return None

    def _move_to_prompt_start(self, _event: tk.Event) -> str:
        self.output.mark_set("insert", self.prompt_mark)
        return "break"

    def _focus_terminal(self, _event: tk.Event) -> None:
        self.after(1, self._keep_cursor_in_command_area)

    def _keep_cursor_in_command_area(self) -> None:
        if self.output.compare("insert", "<", self.prompt_mark):
            self.output.mark_set("insert", "end-1c")
        self.output.focus_set()

    def _paste_terminal(self, _event: tk.Event) -> str:
        if self.command_running:
            return "break"
        self._keep_cursor_in_command_area()
        try:
            text = self.clipboard_get()
        except tk.TclError:
            return "break"
        self.output.insert("insert", text.replace("\r\n", "\n").replace("\r", "\n"))
        self.output.see("end")
        return "break"

    def _flush_output_queue(self) -> None:
        while True:
            try:
                message_type, payload = self.output_queue.get_nowait()
            except queue.Empty:
                break

            if message_type == "connected":
                self._set_connected(True)
            elif message_type == "disconnected":
                self._set_connected(False)
            elif message_type == "dashboard":
                self._apply_dashboard(payload)  # type: ignore[arg-type]
            elif message_type == "refresh_done":
                if self.client:
                    self.refresh_button.configure(state="normal")
                    self.status_var.set("Connected")
            elif message_type == "command_done":
                if self.client:
                    self.command_running = False
                    self.run_button.configure(state="normal")
                    self._write_prompt()
            elif message_type == "terminal":
                self._append_output(str(payload))
            elif message_type == "prompt":
                self._write_prompt()
            elif message_type == "files_path":
                self._load_remote_dir(str(payload))

        self.after(100, self._flush_output_queue)

    def destroy(self) -> None:
        if self.sftp:
            self.sftp.close()
        if self.client:
            self.client.close()
        super().destroy()


if __name__ == "__main__":
    app = SSHControlPanel()
    app.mainloop()
