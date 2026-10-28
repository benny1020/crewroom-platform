"""Own and reap a sandbox's entire child tree before acknowledging settlement."""
import ctypes
import json
import os
import select
import signal
import subprocess
import sys


stopping = False


def request_stop(_signal=None, _frame=None):
    global stopping
    stopping = True


def control_closed(timeout):
    readable, _, _ = select.select([0], [], [], timeout)
    return bool(readable) and not os.read(0, 1)


def settle_owned_children():
    # Only this single-threaded controller reaps these children. A PID read
    # here cannot be reused before our next waitpid, even if it exits while
    # being signalled. Re-read after each wait to include newly adopted orphans.
    children_file = f"/proc/self/task/{os.getpid()}/children"
    while True:
        try:
            while True:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    break
        except ChildProcessError:
            return  # ECHILD is the settlement proof, not bwrap's exit status.
        with open(children_file, encoding="ascii") as children:
            owned = [int(pid) for pid in children.read().split()]
        for pid in owned:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        # Reaping one child may adopt grandchildren. Never acknowledge until
        # the next iteration establishes ECHILD after those adoptions, too.
        os.waitpid(-1, 0)


signal.signal(signal.SIGTERM, request_stop)
signal.signal(signal.SIGINT, request_stop)
result = {"settled": False}
command = None
try:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "subreaper unavailable")
    if not control_closed(0) and not stopping:
        # FD 0 belongs to the controller. EOF (including Node death) requests
        # cleanup. FD 3 is a private acknowledgment and never reaches the job.
        command = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL,
                                   close_fds=True, start_new_session=True)
        while command.poll() is None:
            if control_closed(0.02):
                request_stop()
            if stopping:
                try:
                    command.kill()  # Still our unreaped direct child.
                except ProcessLookupError:
                    pass
                command.wait()
                break
        code = command.returncode
        result.update(exitCode=code if code >= 0 else None,
                      signal=signal.Signals(-code).name if code < 0 else None)
    else:
        result.update(exitCode=None, signal=None)
except Exception:
    # No host paths, arguments, environment or command output enter this channel.
    result["error"] = "runner_workspace_supervisor_failed"
finally:
    try:
        if command is not None and command.poll() is None:
            command.kill()
            command.wait()
        settle_owned_children()
        result["settled"] = True
    except Exception:
        result["error"] = "runner_workspace_cleanup_unconfirmed"
    try:
        os.write(3, (json.dumps(result) + "\n").encode("ascii"))
    except OSError:
        sys.exit(1)
