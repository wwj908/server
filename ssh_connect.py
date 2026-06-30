import getpass
import sys

import paramiko


def connect_server(host: str, port: int, username: str, password: str) -> paramiko.SSHClient:
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
    return client


def run_command(client: paramiko.SSHClient, command: str) -> None:
    stdin, stdout, stderr = client.exec_command(command)
    output = stdout.read().decode("utf-8", errors="replace")
    error = stderr.read().decode("utf-8", errors="replace")

    if output:
        print(output, end="" if output.endswith("\n") else "\n")
    if error:
        print(error, end="" if error.endswith("\n") else "\n", file=sys.stderr)


def main() -> None:
    host = input("服务器 IP: ").strip()
    username = input("用户名: ").strip()
    password = getpass.getpass("密码: ")
    port_text = input("端口(默认 22): ").strip()
    port = int(port_text) if port_text else 22

    if not host or not username or not password:
        print("IP、用户名、密码不能为空。")
        return

    client = None
    try:
        client = connect_server(host, port, username, password)
        print("连接成功。输入命令执行，输入 exit 退出。")

        while True:
            command = input(f"{username}@{host}> ").strip()
            if command.lower() in {"exit", "quit"}:
                break
            if not command:
                continue
            run_command(client, command)
    except paramiko.AuthenticationException:
        print("连接失败：用户名或密码错误。")
    except paramiko.SSHException as exc:
        print(f"SSH 错误：{exc}")
    except TimeoutError:
        print("连接超时，请检查 IP、端口或网络。")
    except ValueError:
        print("端口必须是数字。")
    except OSError as exc:
        print(f"网络错误：{exc}")
    finally:
        if client:
            client.close()


if __name__ == "__main__":
    main()
