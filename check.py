"""第一步命令行原型：只用Python标准库，真实调用百炼，无模拟审核模式。"""
import argparse
import base64
import copy
from datetime import datetime
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
SENSITIVE = ("治疗", "治愈", "无副作用", "零风险", "稳赚")
STATES = {"发现风险", "未发现风险", "无法判断", "不适用"}
OPTIMIZATIONS = {
    "clarity": "可适当缩短长句、合并重复表达，让材料的主要信息更容易理解。此项为可选优化。",
    "tone": "可将抽象口号改为具体的日常行动建议，保留鼓励语气，避免新增效果保证。此项为可选优化。",
    "layout": "可调整字号、行距和信息层级，让正文及已有说明更容易阅读。此项为可选优化。",
}
SAFE_SUGGESTIONS = {
    "A-01": "删除无法证明的绝对化表述；如需保留具体主张，先提供可核验依据并经人工确认，不替换为新的无依据宣传。",
    "A-02": "补充该数据的真实来源、统计口径和时间范围，并由人工核验；无法提供时删除该数据宣传。",
    "A-03": "由业务确认并填写真实的活动起止日期；待填写格式：[开始日期]至[结束日期]，占位符不能直接发布。",
    "A-04": "向业务确认并显著披露适用商品、渠道、名额及叠加限制等主要条件；不适用的条件应明确说明。",
    "A-05": "删除未经验证的效果承诺；如需保留，提供真实验证材料，由人工确认其适用范围后再改写。",
    "A-06": "按题目规则拦截该材料，保留原文并提交人工复核，不由模型自行解除。",
    "A-07": "删除贬损或无法证明的全面优越表述；如需比较，先提供同口径、明确范围的真实依据并经人工确认。",
    "A-08": "确认是否存在押金、运费、自动续费等必要费用并显著披露；费用信息未确认前不要直接使用免费或零元承诺。",
    "A-09": "补充评价或背书的真实性及授权依据，由人工核验；无法提供时删除该评价或背书宣传。",
    "A-10": "提供清晰原文件或完整页面后重新检查；保留本次可见部分已经发现的问题。",
    "A-11": "删除将性别、职业或其他群体身份与负面属性关联的表述，改为针对具体行为、产品或普遍适用的客观提醒；避免仅替换群体称谓而保留贬损暗示，并提交人工复核。",
}


class CheckError(Exception):
    pass


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def load_rules():
    rules = load_json(ROOT / "rules.json")
    ids = [r["id"] for r in rules["rules"]]
    if ids != [f"A-{i:02d}" for i in range(1, 12)]:
        raise CheckError("规则文件必须依次包含A-01至A-11。")
    return rules


def build_payload(text, image_path, evidence, incomplete, config, rules):
    if not text.strip() and image_path is None:
        raise CheckError("请提供非空文字或一张JPG/PNG图片。")
    if len(text) + len(evidence) > 30000:
        raise CheckError("本原型文字与补充证据合计最多30000字符。")
    material = {"广告原文": text, "补充证据_未经独立核实": evidence,
                "用户对材料完整性的声明": "明确声明不完整" if incomplete else "未声明；按实际可见材料判断，不猜测隐藏内容"}
    content = [{"type": "text", "text": json.dumps(material, ensure_ascii=False)}]
    if image_path is not None:
        path = Path(image_path)
        if path.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
            raise CheckError("仅支持JPG/PNG图片。")
        if path.stat().st_size > 10 * 1024 * 1024:
            raise CheckError("图片不可超过10 MB。")
        raw = path.read_bytes()
        if raw.startswith(b"\x89PNG\r\n\x1a\n"):
            mime = "image/png"
        elif raw.startswith(b"\xff\xd8\xff"):
            mime = "image/jpeg"
        else:
            raise CheckError("文件内容不是可识别的JPG/PNG。")
        url = f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")
        content.append({"type": "image_url", "image_url": {"url": url}})
    prompt = (ROOT / "prompts" / "check.txt").read_text(encoding="utf-8")
    prompt += "\n以下为检查规则，A-01至A-10来自题目，A-11为用户新增业务规则：\n" + json.dumps(rules, ensure_ascii=False)
    return {"model": config["model"], "messages": [
        {"role": "system", "content": prompt},
        {"role": "user", "content": content}],
        "response_format": {"type": "json_object"},
        "max_tokens": config["max_tokens"], "stream": False}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise CheckError("接口发生重定向，已停止，避免向其他地址发送密钥。")


def request_model(payload, config):
    key = os.environ.get(config["api_key_env"], "").strip()
    if not key:
        raise CheckError(f"未配置{config['api_key_env']}，请运行configure_key.py。")
    base = config["base_url"].rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    host = parsed.hostname or ""
    allowed = (host == "dashscope.aliyuncs.com" or
               host.endswith(".dashscope.aliyuncs.com") or
               host.endswith(".maas.aliyuncs.com"))
    if parsed.scheme != "https" or not allowed or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.port not in (None, 443):
        raise CheckError("本版本只允许官方百炼HTTPS接口地址。")
    req = urllib.request.Request(base + "/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        method="POST")
    started = time.monotonic()
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=config["timeout_seconds"]) as response:
            data = json.load(response)
    except urllib.error.HTTPError as exc:
        # 不打印服务端原始内容、请求头或密钥；错误只展示可控说明。
        reasons = {400: "请求参数或模型能力不匹配", 401: "密钥无效或地域不匹配",
                   403: "无模型调用权限或账户受限", 404: "模型或接口地址不可用",
                   429: "额度不足或请求限流"}
        raise CheckError(f"HTTP {exc.code}：{reasons.get(exc.code, '模型服务异常')}；本次检查未完成。") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise CheckError("模型网络连接失败或超时；本次检查未完成，可检查网络后重试。") from None
    except (ValueError, UnicodeError):
        raise CheckError("模型服务未返回合法JSON；本次检查未完成。") from None
    try:
        choice = data["choices"][0]
        if choice["finish_reason"] != "stop":
            raise CheckError("模型输出被截断或未正常结束；本次检查未完成。")
        report = json.loads(choice["message"]["content"])
    except (KeyError, IndexError, TypeError, ValueError):
        raise CheckError("模型响应结构异常；本次检查未完成。") from None
    return report, {"provider": config["provider"], "requested_model": config["model"],
        "returned_model": data.get("model"), "request_id": data.get("id"),
        "usage": data.get("usage", {}), "elapsed_seconds": round(time.monotonic() - started, 2),
        "executed_at": datetime.now().astimezone().isoformat(), "mode": "真实API调用"}


def validate_report(report, text, has_image, incomplete, rules):
    def require(condition, message):
        if not condition:
            raise CheckError("结果校验失败：" + message + "；本次检查未完成。")

    require(isinstance(report, dict), "结果不是对象")
    require(type(report.get("input_complete")) is bool, "缺少阅读完整性状态")
    require(isinstance(report.get("extracted_text"), str), "缺少识别原文")
    require(isinstance(report.get("limitations"), list) and all(isinstance(v, str) for v in report["limitations"]), "阅读限制格式错误")
    codes = report.get("optimization_codes", [])
    require(isinstance(codes, list) and len(codes) <= 2 and all(isinstance(code, str) and code in OPTIMIZATIONS for code in codes), "可选优化代码错误")
    report["optimization_suggestions"] = [OPTIMIZATIONS[code] for code in dict.fromkeys(codes)]
    checks = report.get("checks")
    require(isinstance(checks, list) and len(checks) == len(rules["rules"]) and all(isinstance(c, dict) for c in checks), "必须检查当前规则集的全部规则")
    rule_map = {r["id"]: r for r in rules["rules"]}
    ids = [c.get("rule_id") for c in checks]
    require(all(isinstance(i, str) for i in ids) and len(set(ids)) == len(rule_map) and set(ids) == set(rule_map), "规则编号缺失或重复")
    for c in checks:
        require(isinstance(c.get("status"), str) and c["status"] in STATES, "规则状态错误")
        require(isinstance(c.get("reason"), str) and bool(c["reason"].strip()), "缺少规则判断原因")
        issues = c.get("issues")
        require(isinstance(issues, list), "问题列表错误")
        require(bool(issues) == (c["status"] in {"发现风险", "无法判断"}), "状态与问题列表矛盾")
        for issue in issues:
            require(isinstance(issue, dict), "风险条目不是对象")
            for field in ("original_text", "risk_type", "risk_level", "suggestion"):
                require(isinstance(issue.get(field), str) and bool(issue[field].strip()), "缺少字段" + field)
            require(issue["risk_level"] in {"高", "中", "低", "待确认"}, "风险等级无效")
            require(type(issue.get("needs_human_review")) is bool, "人工审核字段不是布尔值")
            require(isinstance(issue.get("human_review_reason"), str), "缺少人工审核原因字段")
            if issue["needs_human_review"]:
                require(bool(issue["human_review_reason"].strip()), "人工审核原因为空")
            if not has_image:
                quote = issue["original_text"]
                require(quote in text or (c["rule_id"] == "A-10" and quote == "无法可靠提取"), "风险原文不是输入中的真实片段")
            issue["rule_id"] = c["rule_id"]
            issue["rule_text"] = rule_map[c["rule_id"]]["requirement"]
            if c["rule_id"] in {"A-06", "A-10", "A-11"} or c["status"] == "无法判断" or issue["risk_level"] in {"高", "待确认"}:
                issue["needs_human_review"] = True
                issue["human_review_reason"] = issue["human_review_reason"].strip() or "命中强制复核规则、高风险或信息不足，需人工确认。"
    by_id = {c["rule_id"]: c for c in checks}
    # 文字判断只能以真实输入为准；图片识别内容仍需使用者核对。
    readable = text + ("\n" + report["extracted_text"] if has_image else "")
    hits = [word for word in SENSITIVE if word in readable]
    if hits:
        c = by_id["A-06"]
        c["status"] = "发现风险"
        c["reason"] = "程序检测到题目敏感词，按A-06强制人工复核。"
        for word in hits:
            if not any(word in i["original_text"] for i in c["issues"]):
                c["issues"].append({"original_text": word, "risk_type": "敏感词",
                    "risk_level": "高", "suggestion": "暂停发布该表述，提交人工复核并提供相关依据。",
                    "needs_human_review": True, "human_review_reason": "题目A-06要求命中敏感词后拦截并人工复核。",
                    "rule_id": "A-06", "rule_text": rule_map["A-06"]["requirement"]})
    incomplete = incomplete or not report["input_complete"] or bool(report["limitations"]) or by_id["A-10"]["status"] in {"发现风险", "无法判断"}
    if has_image and not report["extracted_text"].strip():
        incomplete = True
    if incomplete:
        report["input_complete"] = False
        if not report["limitations"]:
            report["limitations"] = ["材料存在阅读或完整性限制，请补充原文件或完整页面。"]
        c = by_id["A-10"]
        if not c["issues"]:
            c.update(status="无法判断", reason="材料完整性不足，程序强制要求补充材料。")
            c["issues"] = [{"original_text": readable.strip()[:100] or "无法可靠提取",
                "risk_type": "证据不足", "risk_level": "待确认",
                "suggestion": "请提供清晰原文件或完整页面后重新检查。",
                "needs_human_review": True, "human_review_reason": "无法完成整份材料检查。",
                "rule_id": "A-10", "rule_text": rule_map["A-10"]["requirement"]}]
    issues = [issue for c in checks for issue in c["issues"]]
    # 最小版本使用受控整改模板，防止建议里新增无依据事实。
    # 原始模型建议单独保存在raw_model_report，不能直接复制发布。
    for issue in issues:
        issue["suggestion"] = SAFE_SUGGESTIONS[issue["rule_id"]]
        issue["needs_human_review"] = True
        issue["human_review_reason"] = issue["human_review_reason"].strip() or "本原型对所有发现的问题和证据缺口要求人工确认后整改。"
    has_risk = any(c["status"] == "发现风险" for c in checks)
    uncertain = incomplete or any(c["status"] == "无法判断" for c in checks)
    report["overall_status"] = "发现风险" if has_risk else "无法完整判断" if uncertain else "在本次输入和给定规则范围内未发现风险"
    report["needs_human_review"] = uncertain or any(i["needs_human_review"] for i in issues)
    report["checks"] = sorted(checks, key=lambda c: c["rule_id"])
    report["rules_version"] = rules["version"]
    report["image_quotes_verified"] = False if has_image else None
    report["image_note"] = "图片引用来自模型识别，尚未独立OCR核验，请对照原图。" if has_image else ""
    if not has_image:
        report["extracted_text"] = text
    return report


def markdown_report(result):
    meta = result["run"]
    report = result["report"]
    lines = ["# 广告材料检查结果", "", f"运行方式：{meta['mode']}",
        f"运行时间：{meta['executed_at']}", f"模型：{meta['returned_model'] or meta['requested_model']}",
        f"耗时：{meta['elapsed_seconds']} 秒", "", f"总体状态：**{report['overall_status']}**",
        f"是否需要人工审核：{'是' if report['needs_human_review'] else '否'}", "",
        f"规则版本：{report['rules_version']}", "",
        "## 检查输入", "", result["input"]["text"] or "（图片输入，见下方识别文字）", "",
        "## 提取文字", "", report["extracted_text"] or "无法可靠提取", ""]
    if result["input"]["image_file"]:
        lines += ["图片：" + result["input"]["image_file"], report["image_note"], ""]
    if result["input"].get("evidence"):
        lines += ["## 补充证据（未经独立核实）", "", result["input"]["evidence"], ""]
    if report["limitations"]:
        lines += ["## 无法判断的范围", ""] + ["- " + s for s in report["limitations"]] + [""]
    if report.get("optimization_suggestions"):
        lines += ["## 可选优化建议（不计入风险）", ""] + ["- " + s for s in report["optimization_suggestions"]] + [""]
    for check in report["checks"]:
        lines += [f"## {check['rule_id']} {check['status']}", "", check["reason"], ""]
        for issue in check["issues"]:
            lines += [f"- 风险内容原文：{issue['original_text']}",
                f"- 风险类型：{issue['risk_type']}",
                f"- 对应规则：{issue['rule_id']} {issue['rule_text']}",
                f"- 风险等级：{issue['risk_level']}",
                f"- 修改建议：{issue['suggestion']}",
                f"- 是否需要人工审核：{'是' if issue['needs_human_review'] else '否'}",
                f"- 人工审核原因：{issue['human_review_reason'] or '无'}", ""]
    lines += ["---", "", "这是题目规则范围内的初筛结果，不能作为全面合规认证。", ""]
    return "\n".join(lines)


def execute_check(text, image_path=None, evidence="", incomplete=False, image_name=None):
    """CLI与网页共用的真实审核流程。"""
    config, rules = load_json(ROOT / "config.json"), load_rules()
    payload = build_payload(text, image_path, evidence, incomplete, config, rules)
    report, meta = request_model(payload, config)
    raw_report = copy.deepcopy(report)
    report = validate_report(report, text, image_path is not None, incomplete, rules)
    return {"run": meta, "input": {"text": text,
        "image_file": image_name or (Path(image_path).name if image_path else None),
        "evidence": evidence, "declared_incomplete": incomplete}, "report": report,
        "raw_model_report": raw_report,
        "raw_model_report_note": "未经程序修正的模型输出，仅供开发排错，不可作为最终整改建议。"}


def save_result(result, label="检查", directory=None):
    out = Path(directory) if directory else ROOT / "results"
    out.mkdir(exist_ok=True, parents=True)
    label = re.sub(r"[^\w\-\u4e00-\u9fff]", "_", label)[:40] or "检查"
    stem = datetime.now().strftime("%Y%m%d_%H%M%S_%f") + "_" + label
    (out / (stem + ".json")).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    md = out / (stem + ".md")
    md.write_text(markdown_report(result), encoding="utf-8")
    return md


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--text")
    group.add_argument("--text-file", type=Path)
    parser.add_argument("--image", type=Path)
    parser.add_argument("--evidence-file", type=Path)
    parser.add_argument("--incomplete", action="store_true", help="声明图片或材料不完整")
    parser.add_argument("--label", default="检查")
    args = parser.parse_args()
    try:
        text = args.text_file.read_text(encoding="utf-8-sig").strip() if args.text_file else (args.text or "")
        evidence = args.evidence_file.read_text(encoding="utf-8-sig") if args.evidence_file else ""
        print("正在真实调用模型检查材料，请稍候。", flush=True)
        result = execute_check(text, args.image, evidence, args.incomplete)
        report, meta = result["report"], result["run"]
        md = save_result(result, args.label)
        print(json.dumps({"status": report["overall_status"],
            "risk_rules": [c["rule_id"] for c in report["checks"] if c["issues"]],
            "needs_human_review": report["needs_human_review"],
            "elapsed_seconds": meta["elapsed_seconds"], "usage": meta["usage"],
            "result_file": str(md)}, ensure_ascii=False, indent=2))
        return 0
    except (CheckError, OSError, ValueError) as exc:
        # OSError/ValueError信息不含请求对象；不输出任何模型原始响应。
        print(str(exc) if isinstance(exc, CheckError) else "本地文件或配置无效，请检查路径和JSON格式。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
