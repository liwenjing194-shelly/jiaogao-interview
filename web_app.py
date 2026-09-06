"""本机浏览器工作台。仅绑定回环地址，不作为公网生产服务器。"""
import argparse
import base64
import binascii
import getpass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

from check import CheckError, ROOT, execute_check, load_json, load_rules, markdown_report, save_result

APP_ID = "ad-review-local-v1"
MAX_IMAGE = 10 * 1024 * 1024
MAX_BODY = 15 * 1024 * 1024
WEB = ROOT / "web"
RUNTIME = ROOT / ".runtime"


def decode_input(body):
    if not isinstance(body, dict):
        raise CheckError("提交内容格式不正确，请刷新页面再试。")
    text, evidence = body.get("text", ""), body.get("evidence", "")
    incomplete = body.get("incomplete", False)
    if not isinstance(text, str) or not isinstance(evidence, str) or type(incomplete) is not bool:
        raise CheckError("正文、补充证据或完整性标记格式不正确。")
    text, evidence = text.strip(), evidence.strip()
    if len(text) + len(evidence) > 30000:
        raise CheckError("文案与补充证据合计最多30000字符，请缩短后重试。")
    image = body.get("image")
    raw, filename, suffix = None, None, None
    if image is not None:
        if not isinstance(image, dict) or not isinstance(image.get("data"), str) or not isinstance(image.get("name"), str):
            raise CheckError("图片上传信息不完整，请重新选择图片。")
        filename = image["name"].replace("\\", "/").rsplit("/", 1)[-1]
        if not filename or len(filename) > 200 or any(ord(c) < 32 for c in filename):
            raise CheckError("图片文件名无效。")
        suffix = Path(filename).suffix.lower()
        if suffix not in {".jpg", ".jpeg", ".png"}:
            raise CheckError("仅支持JPG、JPEG或PNG图片。")
        data = image["data"]
        if len(data) > (MAX_IMAGE + 2) // 3 * 4:
            raise CheckError("图片不可超过10 MB。")
        try:
            raw = base64.b64decode(data, validate=True)
        except (ValueError, binascii.Error):
            raise CheckError("图片编码无效，请重新选择文件。") from None
        if not raw or len(raw) > MAX_IMAGE:
            raise CheckError("请选择不超过10 MB的有效图片。")
        is_png = raw.startswith(b"\x89PNG\r\n\x1a\n")
        is_jpg = raw.startswith(b"\xff\xd8\xff")
        if not ((suffix == ".png" and is_png) or (suffix in {".jpg", ".jpeg"} and is_jpg)):
            raise CheckError("图片内容与扩展名不匹配，请使用原始JPG/PNG文件。")
    if not text and raw is None:
        raise CheckError("请先填写广告文案或上传一张图片。")
    return text, evidence, incomplete, raw, filename, suffix


def public_result(result, report_id):
    # 原始模型建议只保留在本地排错文件，不进入网页或下载报告。
    return {"id": report_id, "run": result["run"], "input": result["input"],
            "report": result["report"], "markdown": markdown_report(result)}


def process_submission(body, result_dir=None):
    text, evidence, incomplete, raw, filename, suffix = decode_input(body)
    if raw is not None:
        RUNTIME.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="upload-", dir=RUNTIME) as folder:
            upload = Path(folder) / ("material" + suffix)
            upload.write_bytes(raw)
            result = execute_check(text, upload, evidence, incomplete, image_name=filename)
    else:
        result = execute_check(text, evidence=evidence, incomplete=incomplete)
    md = save_result(result, "网页检查", result_dir)
    return public_result(result, md.stem)


def read_saved_report(report_id):
    if not re.fullmatch(r"[\w\-]{1,120}", report_id):
        raise CheckError("报告编号无效。")
    path = ROOT / "results" / (report_id + ".json")
    if not path.is_file() or path.is_symlink():
        raise CheckError("没有找到这份报告。")
    result = load_json(path)
    # 在查看旧记录时同样用当前保护逻辑填入保守建议，源文件不改写。
    from check import validate_report
    previous = result["input"]
    result["report"] = validate_report(result["report"], previous["text"],
        bool(previous.get("image_file")), previous.get("declared_incomplete", False), load_rules())
    result["run"]["history_note"] = "历史真实结果，展示时应用当前整改建议保护；未重新调用模型。"
    return public_result(result, report_id)


def recent_reports():
    directory = ROOT / "results"
    if not directory.is_dir():
        return []
    rows = []
    for path in sorted(directory.glob("*.json"), reverse=True)[:30]:
        try:
            if path.is_symlink():
                continue
            data = load_json(path)
            rows.append({"id": path.stem, "time": data["run"]["executed_at"],
                "status": data["report"]["overall_status"],
                "title": data["input"].get("image_file") or data["input"]["text"][:48],
                "kind": "图片" if data["input"].get("image_file") else "文字"})
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return rows


class ReviewServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port):
        super().__init__(("127.0.0.1", port), Handler)
        self.token = secrets.token_urlsafe(32)
        self.busy = threading.Lock()
        self.origin = f"http://127.0.0.1:{self.server_port}"


class Handler(BaseHTTPRequestHandler):
    server_version = "AdReview"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, format, *args):
        # 不记录材料、请求头或密钥。
        pass

    def send_bytes(self, data, mime="application/json; charset=utf-8", status=200):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def send_json(self, body, status=200):
        self.send_bytes(json.dumps(body, ensure_ascii=False).encode("utf-8"), status=status)

    def allowed_host(self):
        if self.headers.get("Host") not in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}:
            self.send_json({"error": "请通过本机地址打开工作台。"}, 403)
            return False
        return True

    def authenticated(self):
        token = self.headers.get("X-Review-Token", "")
        if not secrets.compare_digest(token, self.server.token):
            self.send_json({"error": "页面会话已失效，请刷新页面后重试。"}, 403)
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in {self.server.origin, f"http://localhost:{self.server.server_port}"}:
            self.send_json({"error": "请求来源不正确。"}, 403)
            return False
        return True

    def do_GET(self):
        if not self.allowed_host():
            return
        path = urllib.parse.urlsplit(self.path).path
        if path == "/health":
            self.send_json({"app": APP_ID, "ready": True})
            return
        if path == "/":
            html = (WEB / "index.html").read_text(encoding="utf-8").replace("__REVIEW_TOKEN__", self.server.token)
            self.send_bytes(html.encode("utf-8"), "text/html; charset=utf-8")
            return
        static = {"/style.css": ("style.css", "text/css; charset=utf-8"),
                  "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                  "/favicon.svg": ("favicon.svg", "image/svg+xml")}
        if path in static:
            filename, mime = static[path]
            self.send_bytes((WEB / filename).read_bytes(), mime)
            return
        if path.startswith("/api/") and not self.authenticated():
            return
        try:
            if path == "/api/config":
                config = load_json(ROOT / "config.json")
                self.send_json({"rules": load_rules(), "key_configured": bool(os.environ.get(config["api_key_env"], "").strip()),
                    "busy": self.server.busy.locked()})
            elif path == "/api/history":
                self.send_json({"items": recent_reports()})
            elif path == "/api/sample-image":
                self.send_bytes((ROOT / "samples" / "04_清晰测试海报.png").read_bytes(), "image/png")
            elif path.startswith("/api/reports/"):
                self.send_json(read_saved_report(urllib.parse.unquote(path.removeprefix("/api/reports/"))))
            else:
                self.send_json({"error": "页面不存在。"}, 404)
        except (CheckError, OSError, ValueError, KeyError, TypeError):
            self.send_json({"error": "暂时无法读取本地资料，请检查文件或重新启动。"}, 400)

    def do_POST(self):
        if not self.allowed_host() or not self.authenticated():
            return
        if self.path == "/api/shutdown":
            if self.server.busy.locked():
                self.send_json({"error": "检查正在进行，请结束后再停止服务。"}, 409)
                return
            self.send_json({"stopped": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if self.path != "/api/check":
            self.send_json({"error": "接口不存在。"}, 404)
            return
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            self.send_json({"error": "提交格式不正确。"}, 415)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if self.headers.get("Transfer-Encoding") or not 0 < length <= MAX_BODY:
            self.send_json({"error": "提交内容为空或过大，图片最多10 MB。"}, 413)
            return
        if not self.server.busy.acquire(blocking=False):
            self.send_json({"error": "已有一份材料正在检查，请等待完成后再试。"}, 409)
            return
        try:
            body = json.loads(self.rfile.read(length))
            self.send_json(process_submission(body))
        except CheckError as exc:
            self.send_json({"error": str(exc)}, 422)
        except (ValueError, UnicodeError):
            self.send_json({"error": "提交数据格式不正确，请重新选择文件或刷新页面。"}, 400)
        except (OSError, KeyError, TypeError, TimeoutError):
            self.send_json({"error": "本次检查未完成，请检查网络及本地配置后重试。输入已保留。"}, 500)
        finally:
            self.server.busy.release()


def existing_server(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
            return json.load(response).get("app") == APP_ID
    except (OSError, ValueError, urllib.error.URLError):
        return False


def stop_server():
    try:
        runtime = load_json(RUNTIME / "server.json")
        port = runtime["port"]
        if type(port) is not int or not 1 <= port <= 65535 or not existing_server(port):
            raise ValueError
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/shutdown", data=b"{}",
            headers={"X-Review-Token": runtime["token"], "Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=3) as response:
            json.load(response)
        print("网页服务已停止。")
        return 0
    except (OSError, ValueError, KeyError, urllib.error.URLError):
        print("未找到可停止的服务，或检查仍在进行。请在运行窗口按Ctrl+C停止。")
        return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    parser.add_argument("--stop", action="store_true", help="停止本项目的本机网页服务")
    args = parser.parse_args()
    if args.stop:
        return stop_server()
    if not 1 <= args.port <= 65535:
        print("端口必须在1到65535之间。")
        return 1
    url = f"http://127.0.0.1:{args.port}"
    if existing_server(args.port):
        print("工作台已经运行：" + url)
        if args.open:
            webbrowser.open(url)
        return 0
    config = load_json(ROOT / "config.json")
    key_env = config["api_key_env"]
    if not os.environ.get(key_env, "").strip() and sys.stdin.isatty():
        os.environ[key_env] = getpass.getpass("请粘贴百炼API Key（输入隐藏，回车确认）：").strip()
    try:
        server = ReviewServer(args.port)
    except OSError:
        print(f"端口{args.port}被其他程序占用。请用--port 8766指定另一个端口。")
        return 1
    RUNTIME.mkdir(exist_ok=True)
    state = RUNTIME / "server.json"
    state.write_text(json.dumps({"pid": os.getpid(), "port": server.server_port, "token": server.token}), encoding="utf-8")
    print("广告合规工作台已启动：" + url, flush=True)
    print("在浏览器输入文案或上传图片即可检查。保留此窗口，Ctrl+C停止。", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        try:
            if load_json(state).get("pid") == os.getpid():
                state.unlink()
        except (OSError, ValueError):
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
