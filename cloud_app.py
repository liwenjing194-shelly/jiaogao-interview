"""受访问码保护的云端入口；与本机版本共用模型检查与输入校验。"""
import hmac
import json
import os
from pathlib import Path
import secrets
import sqlite3
import tempfile
import threading
import time
from datetime import timedelta
from contextlib import contextmanager

from flask import Flask, jsonify, redirect, request, send_file, session
from werkzeug.exceptions import HTTPException
from check import CheckError, ROOT, execute_check, load_json, load_rules
from web_app import MAX_BODY, WEB, decode_input, public_result


@contextmanager
def database(path):
    connection = sqlite3.connect(path)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def create_app(settings=None):
    app = Flask(__name__, static_folder=None)
    app.config.update(
        SECRET_KEY=os.environ.get('SESSION_SECRET', ''),
        ACCESS_CODE=os.environ.get('REVIEW_ACCESS_CODE', ''),
        PUBLIC_ORIGIN=os.environ.get('PUBLIC_ORIGIN', os.environ.get('RENDER_EXTERNAL_URL', '')).rstrip('/'),
        DATA_DIR=os.environ.get('REVIEW_DATA_DIR', str(ROOT / '.cloud-data')),
        MAX_CHECKS=int(os.environ.get('REVIEW_MAX_CHECKS', '50')),
        SESSION_COOKIE_SECURE=True, SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Strict', PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        MAX_CONTENT_LENGTH=MAX_BODY,
    )
    if settings:
        app.config.update(settings)
    if len(app.config['SECRET_KEY']) < 32 or len(app.config['ACCESS_CODE']) < 12:
        raise RuntimeError('请配置至少32字符的SESSION_SECRET和至少12字符的REVIEW_ACCESS_CODE。')
    if not app.config['PUBLIC_ORIGIN'].startswith('https://') and not app.testing:
        raise RuntimeError('PUBLIC_ORIGIN必须是实际HTTPS访问地址。')
    data = Path(app.config['DATA_DIR'])
    data.mkdir(parents=True, exist_ok=True)
    db_path = data / 'reviews.sqlite3'
    with database(db_path) as db:
        db.executescript('CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY, used INTEGER NOT NULL);'
                         'INSERT OR IGNORE INTO budget VALUES (1,0);'
                         'CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, owner TEXT NOT NULL, created REAL NOT NULL, payload TEXT NOT NULL);')
    busy = threading.Lock()
    login_lock = threading.Lock()
    login_attempts = []

    def budget_remaining():
        with database(db_path) as db:
            used = db.execute('SELECT used FROM budget WHERE id=1').fetchone()[0]
        return max(0, app.config['MAX_CHECKS'] - used)

    @app.after_request
    def headers(response):
        response.headers.update({'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"})
        return response

    @app.before_request
    def protect():
        if request.method == 'POST' and request.headers.get('Origin') != app.config['PUBLIC_ORIGIN']:
            return jsonify(error='请求来源不正确，请重新打开工作台。'), 403
        if request.path in {'/health', '/login', '/style.css', '/favicon.svg', '/login.css', '/login.js'}:
            return None
        if not session.get('owner'):
            return (jsonify(error='请先输入访问码进入工作台。'), 401) if request.path.startswith('/api/') else redirect('/login')
        if request.path.startswith('/api/') and not hmac.compare_digest(request.headers.get('X-Review-Token', ''), session.get('csrf', '')):
            return jsonify(error='页面会话已失效，请刷新后重试。'), 403

    @app.get('/health')
    def health():
        return jsonify(app='ad-review-cloud-v1', ready=True)

    @app.route('/login', methods=['GET', 'POST'])
    def login():
        message = ''
        status = 200
        if request.method == 'POST':
            with login_lock:
                now = time.monotonic()
                login_attempts[:] = [t for t in login_attempts if now - t < 60]
                if len(login_attempts) >= 10:
                    return '尝试次数过多，请一分钟后重试。', 429
                login_attempts.append(now)
            if hmac.compare_digest(request.form.get('code', '').encode(), app.config['ACCESS_CODE'].encode()):
                session.clear()
                session.permanent = True
                session['owner'] = secrets.token_urlsafe(24)
                session['csrf'] = secrets.token_urlsafe(32)
                return redirect('/')
            message, status = '访问码不正确，请重试。', 401
        html = (WEB / 'login.html').read_text(encoding='utf-8').replace('__MESSAGE__', message)
        return html, status

    @app.get('/')
    def home():
        html = (WEB / 'index.html').read_text(encoding='utf-8')
        return html.replace('__REVIEW_TOKEN__', session['csrf']).replace('本机工作台', '面试体验版').replace('查看本机最近 30 份真实结果', '查看当前浏览器会话最近 30 份结果，请及时下载保存')

    @app.get('/<name>')
    def static_file(name):
        if name not in {'style.css', 'app.js', 'favicon.svg', 'login.css', 'login.js'}:
            return jsonify(error='页面不存在。'), 404
        return send_file(WEB / name)

    @app.get('/api/config')
    def config():
        cfg = load_json(ROOT / 'config.json')
        return jsonify(rules=load_rules(), key_configured=bool(os.environ.get(cfg['api_key_env'], '').strip()),
                       busy=busy.locked(), cloud=True, checks_remaining=budget_remaining())

    @app.get('/api/sample-image')
    def sample_image():
        return send_file(ROOT / 'samples' / '04_清晰测试海报.png')

    @app.get('/api/history')
    def history():
        with database(db_path) as db:
            rows = db.execute('SELECT payload FROM reports WHERE owner=? ORDER BY created DESC LIMIT 30', (session['owner'],)).fetchall()
        items = []
        for row in rows:
            r = json.loads(row[0])
            items.append({'id': r['id'], 'time': r['run']['executed_at'], 'status': r['report']['overall_status'],
                          'title': r['input']['image_file'] or r['input']['text'][:48],
                          'kind': '图片' if r['input']['image_file'] else '文字'})
        return jsonify(items=items)

    @app.get('/api/reports/<report_id>')
    def report(report_id):
        with database(db_path) as db:
            row = db.execute('SELECT payload FROM reports WHERE id=? AND owner=?', (report_id, session['owner'])).fetchone()
        return (jsonify(json.loads(row[0])) if row else (jsonify(error='没有找到这份报告。'), 404))

    @app.post('/api/check')
    def check():
        if not request.is_json:
            return jsonify(error='提交格式不正确。'), 415
        text, evidence, incomplete, raw, filename, suffix = decode_input(request.get_json())
        if not busy.acquire(blocking=False):
            return jsonify(error='已有材料正在检查，请稍后再试。'), 409
        try:
            with database(db_path) as db:
                cursor = db.execute('UPDATE budget SET used=used+1 WHERE id=1 AND used<?', (app.config['MAX_CHECKS'],))
                if cursor.rowcount != 1:
                    return jsonify(error='体验版检查次数已用完，请联系演示者。'), 429
            with tempfile.TemporaryDirectory(prefix='upload-', dir=data) as folder:
                image = Path(folder) / ('material' + suffix) if raw is not None else None
                if image:
                    image.write_bytes(raw)
                result = execute_check(text, image, evidence, incomplete, image_name=filename)
            public = public_result(result, secrets.token_urlsafe(24))
            public['checks_remaining'] = budget_remaining()
            with database(db_path) as db:
                db.execute('DELETE FROM reports WHERE created<?', (time.time() - 86400,))
                db.execute('INSERT INTO reports VALUES (?,?,?,?)', (public['id'], session['owner'], time.time(), json.dumps(public, ensure_ascii=False)))
            return jsonify(public)
        finally:
            busy.release()

    @app.errorhandler(CheckError)
    def invalid(error):
        return jsonify(error=str(error)), 422

    @app.errorhandler(Exception)
    def failed(error):
        if isinstance(error, HTTPException):
            return jsonify(error='提交内容过大。' if error.code == 413 else '请求无法处理。'), error.code
        return jsonify(error='本次检查未完成，请稍后重试。'), 500

    return app


def main():
    from waitress import serve
    serve(create_app(), host='0.0.0.0', port=int(os.environ.get('PORT', '10000')),
          threads=4, max_request_body_size=MAX_BODY, channel_timeout=130)


if __name__ == '__main__':
    main()
