import threading
import time
import os

_LOG_PATH = os.path.join(os.path.expanduser('~'), 'AppData', 'Local', 'Temp', 'monolith_pty.log')


def _log(msg):
    with open(_LOG_PATH, 'a', encoding='utf-8') as f:
        f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")


class PtyManager:
    def __init__(self):
        self._proc = None
        self._write_callback = None
        self._read_thread = None
        self._running = False

    def spawn(self, command, cwd, on_output=None):
        """Spawn opencode inside a PTY using PtyProcess."""
        from winpty import PtyProcess

        # Clear old log
        try:
            os.remove(_LOG_PATH)
        except Exception:
            pass

        self._write_callback = on_output
        _log(f"Callback set: {on_output is not None}")

        # Spawn opencode directly (no cmd.exe wrapper = no console flash)
        _log(f"Spawning PtyProcess: {command}, cwd={cwd}")

        try:
            self._proc = PtyProcess.spawn(command, cwd=cwd, dimensions=(24, 80))
            _log(f"Spawned! PID={self._proc.pid}, alive={self._proc.isalive()}")
        except Exception as exc:
            _log(f"spawn() raised exception: {exc}")
            raise

        self._running = True
        self._read_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._read_thread.start()
        _log("Read thread started")

    def _read_loop(self):
        """Background thread that reads PTY output and forwards it."""
        _log("_read_loop started")
        last_error = None
        while self._running and self._proc and self._proc.isalive():
            try:
                data = self._proc.read()
                if data and self._write_callback:
                    self._write_callback(data)
            except EOFError:
                _log("read() EOFError - PTY closed")
                break
            except Exception as exc:
                last_error = str(exc)
                _log(f"read() exception: {exc}")
                break
        _log(f"_read_loop ending. last_error={last_error}, running={self._running}, alive={self._proc.isalive() if self._proc else 'none'}")
        if self._write_callback:
            msg = "\r\n[opencode exited]\r\n"
            if last_error:
                msg = f"\r\n[opencode exited - error: {last_error}]\r\n"
            self._write_callback(msg)

    def write_input(self, data):
        """Write raw input into the PTY."""
        if self._proc and self._running and self._proc.isalive():
            self._proc.write(data)

    def resize(self, cols, rows):
        """Resize the PTY."""
        if self._proc:
            try:
                self._proc.setwinsize(rows, cols)
            except Exception:
                pass

    def terminate(self):
        """Kill the PTY process and stop the read thread."""
        self._running = False
        if self._proc:
            try:
                if self._proc.isalive():
                    self._proc.sendintr()  # Ctrl+C
                    time.sleep(0.1)
                    self._proc.terminate()
            except Exception:
                pass
            try:
                self._proc.close()
            except Exception:
                pass
            self._proc = None
        if self._read_thread and self._read_thread.is_alive():
            self._read_thread.join(timeout=1)
