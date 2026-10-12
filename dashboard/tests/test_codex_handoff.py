"""Exercise the real HTTP handoff without an external model or user files."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location("dashboard_server", Path(__file__).parents[1] / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class CodexHandoffTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        class Handler(server.Handler):
            jobs_dir = str(self.root / "jobs")
            projects_dir = str(self.root / "projects")
            def log_message(self, *args):
                pass
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:%d" % self.httpd.server_port

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        self.temp.cleanup()

    def post(self, path, data):
        req = Request(self.base + path, data=json.dumps(data).encode(), headers={"Content-Type": "application/json"})
        try:
            with urlopen(req) as res:
                return res.status, json.load(res)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_saved_project_upload_and_distinct_jobs(self):
        status, saved = self.post("/api/project/save", {"id": "demo", "data": {"project": {"id": "demo"}}})
        self.assertEqual(status, 200)
        self.assertTrue(saved["ok"])
        media = b"source media payload"
        req = Request(self.base + "/api/media/upload?project=demo&name=source.mp4", data=media, method="POST")
        with urlopen(req) as res:
            uploaded = json.load(res)
        self.assertEqual(Path(uploaded["path"]).read_bytes(), media)
        payload = {"kind": "스타일 적용", "prompt": "한글 자막 · 미리보기만", "job": {
            "task": "style.apply", "project": "demo", "mediaPaths": [{"group": "apply.target", "path": uploaded["path"]}]}}
        status, first = self.post("/api/job", payload)
        _, second = self.post("/api/job", payload)
        self.assertEqual(status, 200)
        self.assertNotEqual(first["job"], second["job"])
        stored = json.loads(Path(first["job"]).read_text())
        self.assertEqual(stored["agent"], "codex")
        self.assertEqual(stored["project"], "demo")
        self.assertEqual(stored["mediaPaths"][0]["path"], uploaded["path"])
        self.assertIn(stored["projectFile"], first["request"])
        self.assertIn(first["job"], first["request"])
        self.assertIn(first["prompt"], first["request"])
        self.assertEqual(Path(first["prompt"]).read_text(), payload["prompt"])

    def test_invalid_jobs_do_not_create_files(self):
        for job in [None, [], "bad", {}, {"project": "missing"}, {"project": "../../outside"}]:
            with self.subTest(job=job):
                status, body = self.post("/api/job", {"job": job})
                self.assertEqual(status, 400)
                self.assertFalse(body["ok"])
        self.assertFalse((self.root / "jobs").exists())


if __name__ == "__main__":
    unittest.main()
