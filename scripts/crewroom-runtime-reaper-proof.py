#!/usr/bin/env python3
"""Small Linux-only subprocess proof. No product runtime, network or credentials."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import signal
import resource
import subprocess
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location("qualification", Path(__file__).with_name("crewroom-runtime-qualification.py"))
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


def wait_for(condition, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError("proof_condition_timeout")


def process_state(pid):
    try:
        # Linux comm may itself contain spaces or parentheses.
        stat = Path(f"/proc/{pid}/stat").read_text()
    except FileNotFoundError:
        return None
    fields = stat[stat.rfind(")") + 2:].split()
    return fields[0], int(fields[1])


def worker(exception_mode):
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise AssertionError("subreaper_required")
    result = {}
    current = None
    reaper = None
    with tempfile.TemporaryDirectory(prefix="qualification-reaper-proof-", dir=sys.argv[2] if len(sys.argv) > 2 else None) as directory:
        root = Path(directory)
        controller = r'''
import json, os, pathlib, sys, time
root = pathlib.Path(sys.argv[1])
middle = os.fork()
if middle == 0:
    dead = os.fork()
    if dead == 0:
        os.setsid()
        time.sleep(0.1)
        os._exit(0)
    live = os.fork()
    if live == 0:
        os.setsid()
        time.sleep(30)
        os._exit(0)
    (root / "children.json").write_text(json.dumps({"dead": dead, "live": live}))
    os._exit(0)
os.waitpid(middle, 0)
while not (root / "release").exists():
    time.sleep(0.01)
os._exit(7)
'''
        try:
            current = subprocess.Popen([sys.executable, "-c", controller, str(root)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            wait_for(lambda: (root / "children.json").exists())
            children = json.loads((root / "children.json").read_text())
            dead, live = children["dead"], children["live"]
            wait_for(lambda: process_state(dead) == ("Z", os.getpid()))
            # Reproduce the prior helper behavior: a dead adopted provider still
            # satisfies kill(pid, 0) while communicate's direct child is alive.
            os.kill(dead, 0)
            result["zombieRetainedBeforeReaper"] = True
            reaper = qualification.AdoptedZombieReaper(current.pid)
            reaper.start()
            wait_for(lambda: process_state(dead) is None)
            result["zombieGoneDuringCommand"] = current.poll() is None
            assert result["zombieGoneDuringCommand"]
            assert process_state(live)[1] == os.getpid()
            time.sleep(0.1)
            os.kill(live, 0)
            result["liveAdoptedChildPreserved"] = process_state(live)[0] != "Z"
            assert result["liveAdoptedChildPreserved"]
            if exception_mode:
                raise RuntimeError("synthetic_proof_exception")
            # The proof, not the reaper, stops this exact verified owned child.
            os.kill(live, signal.SIGTERM)
            wait_for(lambda: process_state(live) is None)
            (root / "release").touch()
            wait_for(lambda: process_state(current.pid)[0] == "Z")
            time.sleep(0.1)
            current.communicate(timeout=5)
            assert current.returncode == 7
            result["directPopenExitCode"] = current.returncode
        except RuntimeError as error:
            if not exception_mode or str(error) != "synthetic_proof_exception":
                raise
            result["exceptionPathEntered"] = True
        finally:
            if current is not None and current.poll() is None:
                (root / "release").touch()
                # wait() does not wait for a descendant's inherited pipe.
                try:
                    current.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    current.terminate()
                    current.wait(timeout=2)
            if reaper is not None:
                reaper.stop()
                result["reaperThreadJoined"] = reaper.joined
            result["ownedCleanup"] = qualification.owned_children_cleanup()
            if current is not None:
                current.communicate(timeout=2)
            assert result["ownedCleanup"]
    return result


def main():
    if sys.platform != "linux":
        raise AssertionError("linux_required")
    if len(sys.argv) > 1:
        print(json.dumps(worker(sys.argv[1] == "exception")))
        return
    # Become an outer subreaper too, so even a failing worker cannot strand
    # descendants at PID 1. Its separate ownership still cannot reap/kill the
    # sibling sentinel while the worker is running.
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise AssertionError("outer_subreaper_required")
    result = {}
    with tempfile.TemporaryDirectory(prefix="qualification-proof-owner-") as fixture_root:
        sentinel = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for mode in ["normal", "exception"]:
                child = subprocess.Popen([sys.executable, __file__, mode, fixture_root], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    stdout, _stderr = child.communicate(timeout=15)
                finally:
                    if child.poll() is None:
                        child.terminate()
                        child.wait(timeout=2)
                assert child.returncode == 0
                result[mode] = json.loads(stdout)
                assert sentinel.poll() is None
            result["siblingOutsideWorkerPreserved"] = sentinel.poll() is None
        finally:
            if sentinel.poll() is None:
                sentinel.terminate()
            sentinel.wait(timeout=2)
            result["outerOwnedCleanup"] = qualification.owned_children_cleanup()
            assert result["outerOwnedCleanup"]
    result["maximumChildRssKiB"] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        print("Linux child reaper proof: failed")
        sys.exit(1)
