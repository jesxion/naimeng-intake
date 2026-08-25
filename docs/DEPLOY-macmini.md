# 部署到办公室 Mac mini

服务跑在局域网内一台 Mac mini 上，同事用浏览器打开 `http://<IP>:5173` 使用。
不依赖外网：断网时登录、录入、查询全部照常，只有调用大模型识别那一步需要网。

---

## 0. 先想清楚这几件事

| 事项 | 结论 |
|---|---|
| 谁能访问 | 同网段任何设备都能连到端口，**靠团队口令挡住**，不是靠"内网所以安全" |
| 传输加密 | 无。局域网明文 http，会话 cookie 在同网段可被嗅探 |
| 数据在哪 | 只在这台机器的 `data/` 目录里，**没有异地副本** |
| 要不要外网 | 不要也能用。只有大模型识别和飞书同步需要外网，两者失败都不阻断业务 |
| 断电断网 | 断网照常用；断电后靠开机自启恢复 |

明文这一条不粉饰：办公室网络里有不受控设备（访客手机、打印机、摄像头）时，
风险是真实的。6 个人的团队通常接受它，但这是个选择，不是"没问题"。

---

## 1. 装 Node

```bash
# 装 Homebrew（已有就跳过）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install node
node -v        # 需要 22 以上，本项目用到 node:sqlite
```

---

## 2. 放代码

```bash
mkdir -p ~/apps && cd ~/apps
git clone https://github.com/jesxion/naimeng-intake.git
cd naimeng-intake
npm test       # 应该全绿，绿了再往下走
```

不要放在 `~/Desktop` 或 `~/Documents` —— 那两个目录在开了 iCloud 同步时
会被同步上去，`data/` 里是达人的真实姓名手机号地址。

---

## 3. 固定 IP

DHCP 会换地址，换了之后同事的书签就失效了。两个办法二选一：

**路由器上做 DHCP 保留**（推荐，不用改 Mac 设置）
在路由器管理页面把 Mac mini 的 MAC 地址绑定到一个固定 IP。

**Mac 上设静态 IP**
系统设置 → 网络 → 以太网 → 详细信息 → TCP/IP → 配置 IPv4 选「手动」。
注意要避开路由器的 DHCP 分配范围，否则会和别的设备撞车。

顺带记下 Bonjour 名字，它比 IP 好记且不随 IP 变：

```bash
scutil --get LocalHostName     # 比如输出 naimeng-server
```

同事可以用 `http://naimeng-server.local:5173` 访问（Mac 和 Windows 10+ 都支持）。
建议两个地址都告诉大家，`.local` 不通时还有 IP 兜底。

---

## 4. 禁止睡眠

**这一条最容易被忽略，也最容易让人误以为"系统挂了"。**
Mac mini 默认会睡，一睡局域网访问全部超时。

```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 10 womp 1
pmset -g            # 确认 sleep 为 0
```

`womp 1` 是允许网络唤醒，作为二次保险。
显示器睡眠（`displaysleep`）不影响服务，可以留着省电。

**如果开了 FileVault**：重启后在有人手动登录之前磁盘是锁的，
LaunchAgent 起不来。机器无人值守时要么关掉 FileVault，
要么改用 LaunchDaemon（以 root 运行，不依赖用户登录）。

---

## 5. 开机自启（launchd）

创建 `~/Library/LaunchAgents/com.naimeng.intake.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.naimeng.intake</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/你的用户名/apps/naimeng-intake/server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/你的用户名/apps/naimeng-intake</string>

  <key>EnvironmentVariables</key>
  <dict>
    <!-- 关键：默认只绑回环，局域网访问必须显式打开 -->
    <key>HOST</key>
    <string>0.0.0.0</string>
    <key>PORT</key>
    <string>5173</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/你的用户名/apps/naimeng-intake/data/server.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/你的用户名/apps/naimeng-intake/data/server.err.log</string>
</dict>
</plist>
```

两处要改：**用户名**，以及 node 的真实路径（Apple 芯片是
`/opt/homebrew/bin/node`，Intel 芯片是 `/usr/local/bin/node`，
用 `which node` 确认）。

加载：

```bash
launchctl load -w ~/Library/LaunchAgents/com.naimeng.intake.plist
launchctl list | grep naimeng          # 有输出即已注册
curl -s localhost:5173/api/auth/state  # 应返回 JSON
```

改完代码后重启服务：

```bash
launchctl kickstart -k gui/$(id -u)/com.naimeng.intake
```

`KeepAlive` 会在进程崩溃时自动拉起，这是不上 Docker 也能有的守护能力。

---

## 6. 防火墙

macOS 应用防火墙默认可能拦掉入站连接：

系统设置 → 网络 → 防火墙 → 选项 → 把 `node` 加进去并允许传入连接。
或者临时关掉防火墙验证是否是它导致连不上。

---

## 7. 首次初始化

浏览器打开 `http://<IP>:5173`，会看到初始化界面：

1. 设置**团队口令**（至少 6 位）—— 这是唯一一道门，认真选
2. 填你自己的姓名和角色

之后同事各自打开这个地址，输口令、从名单里选自己就能进。
登录状态保留 30 天。

口令只存 scrypt 哈希，不存明文。**忘了只能重置**：

```bash
# 停服务 → 清掉口令哈希 → 重启 → 重新初始化
launchctl unload ~/Library/LaunchAgents/com.naimeng.intake.plist
node -e "const f='data/settings.json',s=JSON.parse(require('fs').readFileSync(f));s.auth.passphrase='';require('fs').writeFileSync(f,JSON.stringify(s,null,2))"
launchctl load -w ~/Library/LaunchAgents/com.naimeng.intake.plist
```

**踢所有人下线**（比如有人离职、或怀疑口令外泄）：
删掉 `data/.session-secret` 再重启，所有已签发的会话立刻失效。

---

## 8. 配模型

登录后进「设置 → 模型设置」填 Base URL、模型名、API Key，点**测试连接**。

保存成功不代表能用 —— 一定要点测试连接看到「连接成功」。
（这一点是有来历的：曾经有个 bug 让保存永远显示成功而配置根本没生效。）

发货截图识别要另外配「视觉模型」，文本模型不支持读图。

---

## 8.5 配飞书同步（可选）

把合作信息推到飞书。**这一步需要这台机器能访问外网**，
但同步失败不影响商务干活 —— 断网时照样能建档，恢复后队列自动补推。

**不往团队现用的那张表推**，而是新建一张「系统表」只给程序写，
团队表用飞书原生的关联 + 查找引用去取值。
完整理由和列定义见 `docs/飞书同步方案-v2.md`。

1. 飞书开发者后台建一个**企业自建应用**，权限勾上**多维表格编辑**
   （`bitable:app`，不是只读版），**申请完必须发布新版本并等管理员通过**
2. **打开那张多维表格**，右上角「…」→「更多」→「添加文档应用」，
   把应用加进去，权限选**可编辑**
3. 在多维表格里**新建一张空数据表**（建议叫「系统同步」）
4. 系统里：设置 → 飞书同步 → 填 App ID / Secret / 表格链接 → 测试连接
5. 建列：

```bash
cd ~/apps/naimeng-intake
node tools/feishu-inspect.js                    # 找到新表的 table_id
node tools/feishu-scaffold.js <table_id>        # 预演，只打印计划
node tools/feishu-scaffold.js <table_id> --apply
```

6. 回设置页选中这张表，映射会按同名自动匹配，**核对后点保存**
7. 在团队表里加「关联」列指向系统表，再加若干「查找引用」列

> 第 1、2 步各有一个坑，而且症状不一样：
>
> · 只在后台申请权限**不够**，少了第 2 步接口一律返回 **91403**
> · 权限勾成只读版、或第 2 步给的是「可阅读」，读得到但写不进，
>   返回 **1254302**
>
> 两个码系统都翻译成了可操作的提示。看到「应用没被加进这张表」查第 2 步，
> 看到「只有读权限」查权限范围（**改完记得发版**）。

> **「测试连接」通过不代表能写。** 它从头到尾都是读操作，
> 最后一级会明确写着「写入权限：未验证」。真正的验证是跑一次 scaffold。

配好后合作记录表会多一列「飞书同步」，每条记录的状态一眼可见；
点开详情能看到失败的原始原因并手动重推。

**被同步的列在飞书里手工改会被下次推送覆盖** —— 单向推送，
系统表当只读看板用；要人工维护的信息放在团队表自己的列里。

---

## 9. 备份

启动时自动备份到 `data/backups/`，保留最近 7 份。但**那些副本和数据库在同一块硬盘上**
——硬盘坏了就一起没了。必须往外拷一份。

最省事的是开 Time Machine 接一块移动硬盘。
或者加一个每天往 NAS / 另一台机器同步的定时任务：

```bash
# ~/Library/LaunchAgents/com.naimeng.backup.plist 里跑这条
rsync -a ~/apps/naimeng-intake/data/ /Volumes/备份盘/naimeng-data/
```

**恢复**：先停服务，把 `data/backups/` 里挑一份改名成 `naimeng.db` 覆盖回去，
同时删掉可能残留的 `naimeng.db-wal` 和 `naimeng.db-shm`，再启动。

---

## 10. 排查

| 症状 | 先看这里 |
|---|---|
| 同事打不开，本机能开 | `HOST` 是不是没设成 `0.0.0.0`；防火墙 |
| 早上打不开，下午好了 | 睡眠没禁；`pmset -g` 确认 |
| 突然全员要重新登录 | `data/.session-secret` 是不是被删了或换了 |
| 识别一直是「本地模拟」 | 模型没配好，去设置里点测试连接看真实报错 |
| 地址变了 | DHCP 换了 IP，去做保留或静态 IP |
| 飞书表不更新 | 先看合作记录表的「飞书同步」列；红的点开看原始报错 |
| 飞书报 91403 | 应用没被加进那张表（「…」→「更多」→「添加文档应用」）|
| 飞书报 1254302 | 只有读权限：权限范围勾了只读版（改完要发版）、或文档应用给的是「可阅读」、或表开了高级权限 |
| 飞书表里出现重复行 | 「系统ID」列没映射，或那一列被改名了 |
| 某一列永远是空的 | 映射里那一项没选，或选完没点保存 |

**先看界面里的日志**：设置 → 运行日志。左边是「谁做了什么」，右边是「哪里坏了」。
大部分问题在那里就能定位，不用登到机器上。

进程级的日志（起不来、崩溃、端口占用）在 `data/server.log`
和 `data/server.err.log` —— 那些情况下界面本身就打不开。

```bash
tail -f data/server.log
```

飞书那块出问题时，先用这个脚本看一眼对面的真实结构 —— 它只读，
凭据从 `data/settings.json` 里取，不会打印 Secret：

```bash
node tools/feishu-inspect.js                  # 列出这个多维表格里的所有表
node tools/feishu-inspect.js tbl2zfl51fVdGq5n  # 看某张表有哪些列、什么类型
```

界面上「下拉里没有这一列」通常有两种原因，这个脚本能分辨：
列压根不存在，还是存在但类型只读（公式、自动编号、创建时间这类写不进去）。

---

## 11. 这套方案的边界

**能扛住**：断网、断电重启、进程崩溃、误删数据（有备份）、访客设备乱连（有口令）。

**扛不住**：硬盘损坏（所以第 9 条必须做）、同网段的流量嗅探（明文 http）、
有人拿到团队口令后冒充同事（口令是共享的，区分不了具体是谁在用）。

最后一条如果哪天变得重要 —— 比如团队扩到十几人、或者需要审计谁改了什么 ——
那就该换成每人一套凭据了。现在 6 个人同处一间办公室，共享口令是合理的取舍。
