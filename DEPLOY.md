# 云端部署说明

## 当前状态

2026年9月6日：云端适配和32项本地回归验证完成。Render已登录并进入创建Web Service页面；正在连接GitHub，当前需要用户完成GitHub登录。独立部署源码仓库已在本地建立，尚未创建线上服务，尚无已验证可访问的公网地址。

本版采用Flask与Waitress提供云端入口，共用本机的输入校验、规则、提示词和模型调用。依赖版本已在本项目虚拟环境中安装并通过测试。云端使用`cloud_app.py`，本机仍使用`run_web.cmd`。

## Render部署步骤

1. 登录[Render控制台](https://dashboard.render.com/login)。若已有其他托管平台，也可使用下方同一启动命令。
2. 把经过白名单整理的部署源文件放入你自己的GitHub私有仓库，并授权Render读取该仓库。不要上传整个“字节”目录或历史报告。
3. 在Render创建Blueprint，选择仓库根目录的`render.yaml`。配置中选择Free实例；不自动开通付费实例。
4. 按控制台要求填写`DASHSCOPE_API_KEY`和`REVIEW_ACCESS_CODE`。密钥仅填服务端环境变量，不发送到聊天、不写入源代码。访问码至少12字符，用于提供给面试官；它与模型密钥不同。
5. `SESSION_SECRET`由Blueprint随机生成。Render提供`RENDER_EXTERNAL_URL`作为实际站点源地址。手动部署或自定义域名时，另设`PUBLIC_ORIGIN=https://实际域名`，不带末尾斜杠。
6. 构建命令：`pip install -r requirements.txt`；启动命令：`python cloud_app.py`；健康检查：`/health`。平台通过`PORT`指定监听端口。使用单实例、单进程，避免绕过全局并发锁。
7. 构建成功后，在浏览器打开平台分配的HTTPS地址，输入访问码；使用自制文案和自制海报验证模型网络、结果与报告下载，再用手机移动网络测试。

Render的Python后端、部署配置和HTTPS能力见[官方部署说明](https://render.com/docs/deploy-flask)与[Blueprint参考](https://render.com/docs/blueprint-spec)。最终是否能从面试网络访问，需要真实验证，不能仅凭构建成功认定。

## 体验次数与数据

- 默认`REVIEW_MAX_CHECKS=50`：所有访客共享当前数据目录的50次尝试额度。无效输入不计数；已进入模型调用的失败也计数，避免自动重试消耗额度。没有自动模型重试。
- 该数字是应用限制，不是百炼免费余额，也不能保证不产生费用。模型密钥不要发给访客。
- 访问码保护页面；API还要求会话和来源校验。登录失败全局最多每分钟10次。
- 记录以随机会话标识隔离，另一个浏览器不能读取你的记录。上传图片临时处理后删除；云端只保存最终报告，不保存模型原始响应。登录会话有效期8小时。新检查时清理超过24小时的旧报告。
- 默认SQLite数据目录为`.cloud-data`。Render免费实例休眠、重启或重新部署会丢失本地文件，因此历史报告和应用次数计数都可能重置。此上限不是跨重启的账户费用硬上限。需要长期保存时须另配持久化服务。
- Render免费实例闲置15分钟后休眠，重新访问可能需约1分钟唤醒。面试前提前打开，并下载重要报告。相关限制见[官方免费实例说明](https://render.com/docs/free)。

## 验证

运行项目虚拟环境中的Python：

```powershell
.venv/Scripts/python.exe -X utf8 -m unittest discover -s tests -q
```

32项测试通过，包含未登录拦截、跨来源与CSRF检查、跨会话报告隔离、共享次数限制、上传失败清理、登录限流、缺少密钥配置时拒绝启动，以及原有本机检查测试。测试使用固定结果，不代表线上模型调用已验证。

## 打包

运行`python build_deploy.py`，生成`deploy-dist/校稿部署包.zip`和可直接放入仓库的`deploy-dist/source`目录。脚本只复制明确允许的源文件、自制示例及部署文档，排除个人材料、历史结果、密钥、虚拟环境和运行数据。
