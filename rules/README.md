# HGhub 分流规则

统计日期：2026-11-10。包含 6 条域名后缀规则和 3 条精确域名规则；没有已确认的固定服务端 IP/CIDR。规则只决定流量如何分流，不改变应用的账号信任或正文清洗策略。

## 域名来源

| 匹配方式 | 域名 / 后缀 | 用途及证据 |
| --- | --- | --- |
| 后缀 | `huangguoai.com` | 固定 API 线路 1，正文相对 URL 的基址；`src-tauri/src/net.rs`、`src/html.ts` |
| 后缀 | `huangguoai.ai` | 固定 API 线路 2；`src-tauri/src/lines.rs` |
| 精确 | `huangguoai.pages.dev` | 镜像发布页及其 `publish.js`；`src-tauri/src/lines.rs` |
| 后缀 | `drleao.cn` | 封面与头像 `pic.drleao.cn`，HLS 分片与密钥 `tp1.drleao.cn`；2026-11-10 播放接口实测，`src-tauri/src/media.rs` 联网测试 |
| 后缀 | `hzjvlo.cn` | 视频主播放列表 `yd-lphu-long.hzjvlo.cn`，图片备用主机 `pic.hzjvlo.cn`；2026-11-10 播放接口实测 |
| 后缀 | `adihsppe.cc` | 当前镜像域名，发布页 `var urls` 的唯一条目，子域为 `thu`、`pku` 等；2026-11-10 在线核对 |
| 后缀 | `xxbgwypx.cc` | 镜像样本 `thu.xxbgwypx.cc` 及动态子域；`src-tauri/src/lines.rs` 测试 |
| 精确 | `api.github.com` | GitHub Release 更新元数据；`src-tauri/src/api.rs` |
| 精确 | `github.com` | 更新页面，用户点击后交给外部浏览器；`src-tauri/src/api.rs` |

CDN 和镜像后缀来自发布页在线核对与仓库样本。2026-11-10 发布页返回 HTTP 200，`var urls` 只有 `adihsppe.cc/`，`var subdomains` 是 `thu`、`pku`、`fdu` 等学术简称数组，由页面随机拼接，因此镜像域名必须按后缀匹配。`hzjvlo.cn` 此前只有测试样本，本次已从播放接口实测得到在用主机。API 返回的封面、播放地址，HLS 子清单、分片、密钥、重定向地址及镜像列表都可能引入新域名，因此这是一份已知目标清单，不是完整流量白名单。新域名应依据代理连接日志继续补充。

GitHub 是共享基础设施，这两条精确规则也会匹配其他程序对同域名的访问。应用只打开更新网页，不自动下载更新包；外部浏览器下载时使用的其他 GitHub/CDN 域名未纳入本清单。

## 为什么这些域名必须走代理（2026-11-10 实测）

同一台机器、同一时刻逐 IP 做 TLS 握手的结果：

| 主机 | 解析到的 IP | 握手结果 |
| --- | --- | --- |
| `pic.drleao.cn` | `39.175.228.12`、`39.175.228.166` | 两个节点全部 RST，握手收到 0 字节 |
| `tp1.drleao.cn` | `117.135.155.184`、`117.135.155.186`、`120.226.186.51`、`223.113.131.140` | 两个节点正常，两个节点 RST |
| `yd-lphu-long.hzjvlo.cn` | `112.28.174.102`、`39.174.179.6` | 正常，主播放列表返回 HTTP 200 |

对照实验：在同一个 IP、同一个端口上，只要 SNI 不是 `pic.drleao.cn`（含不带 SNI），TLS 都能握手完成，并按 `Host` 头取回完整对象；换成 `pic.drleao.cn` 就断在 ClientHello 之后、ServerHello 之前。这是链路对 SNI 的拦截，不是证书或 TLS 参数问题，客户端改 TLS 配置绕不过去，也不接受用「不带 SNI + 跳过证书校验」这种写法绕过。

后果是两类资源同时受影响：封面和头像全部失败；`hzjvlo.cn` 的主清单里 166 条分片与 AES 密钥地址全部指向 `tp1.drleao.cn`，所以播放同样依赖 `drleao.cn`，只是那台机器上恰好有一半节点可用。

这些 CDN 解析到国内地址，兜底的 `GEOIP,CN,DIRECT` 或等价规则会把它们送回直连，正好落回被拦截的路径。**域名规则必须排在 `GEOIP` 和 `MATCH` 之前**，否则不会生效。CDN 节点随调度变化，不要改用 IP 或 CIDR 规则。

## Mihomo

使用 [hghub.list](hghub.list)，这是 `classical` 行为、`text` 格式的规则集合。将 `rules` 目录放在 Mihomo 配置目录中，并合并以下配置；把 `PROXY` 替换成已有代理组名。规则应放在其他兜底规则之前。

```yaml
rule-providers:
  hghub:
    type: file
    behavior: classical
    format: text
    path: ./rules/hghub.list

rules:
  - RULE-SET,hghub,PROXY
```

也可通过 HTTP 托管该文件后使用 `type: http`，填写实际 `url` 和更新周期。`.list` 不包含策略名，不要直接作为完整的 `rules:` 配置粘贴。

## OpenClash

OpenClash 的自定义规则每一行都必须带策略名。`hghub.list` 里没有策略名，不能直接粘进规则框；粘贴前把下面的 `PROXY` 全部换成你自己的代理分组名（例如 `🚀 节点选择`、`节点选择`）。已有 GitHub 分流分组的话删掉最后两行。

```text
DOMAIN-SUFFIX,huangguoai.com,PROXY
DOMAIN-SUFFIX,huangguoai.ai,PROXY
DOMAIN,huangguoai.pages.dev,PROXY
DOMAIN-SUFFIX,adihsppe.cc,PROXY
DOMAIN-SUFFIX,xxbgwypx.cc,PROXY
DOMAIN-SUFFIX,drleao.cn,PROXY
DOMAIN-SUFFIX,hzjvlo.cn,PROXY
DOMAIN,api.github.com,PROXY
DOMAIN,github.com,PROXY
```

粘贴位置：**OpenClash → 插件设置 → 规则设置 → 自定义规则**（对应 `/etc/openclash/custom/openclash_custom_rules.list`，也就是覆写里的「其他规则」）。保存后重载。这几条要落在 `GEOIP,CN,DIRECT` 和 `MATCH` 之前，OpenClash 的「其他规则」默认就插在兜底规则之前；如果你另外手改过规则顺序，请自己核对。

想用规则集合的话，把 `rules` 目录放进 OpenClash 配置目录，在 **Rule Providers 设置** 里添加本地 Provider（名称 `hghub`、类型 `File`、行为 `classical`、格式 `text`、路径 `/etc/openclash/rules/hghub.list`），再在自定义规则里只写一行：

```text
RULE-SET,hghub,PROXY
```

生效后在走 OpenClash DNS 的客户端上核对：`nslookup pic.drleao.cn` 在 FakeIP 模式下应返回 `198.18.x.x`；仍然返回 `39.175.x.x` 说明没命中规则，优先检查代理分组名是否写对、`sniffing` 是否开启。封面失败不会被写进内存缓存（`src-tauri/src/media.rs` 只缓存成功结果），所以回到应用重新进入页面即可重新拉取，不必清理缓存。

## sing-box

使用 [hghub.json](hghub.json)，源规则集版本为 2，适用于 sing-box 1.10 及以上。将目录放在配置目录中，合并到现有 `route`；把 `proxy` 替换成实际出站标签，放在兜底规则之前。

```json
{
  "route": {
    "rule_set": [
      {
        "type": "local",
        "tag": "hghub",
        "format": "source",
        "path": "./rules/hghub.json"
      }
    ],
    "rules": [
      {
        "rule_set": ["hghub"],
        "action": "route",
        "outbound": "proxy"
      }
    ]
  }
}
```

以上路由动作写法适用于 sing-box 1.11 及以上；1.10 使用相同源规则集时，删除路由项中的 `"action": "route"`。

需要二进制规则集时可使用已编译的 [hghub.srs](hghub.srs)，将配置的 `format` 改为 `binary`、`path` 改为 `./rules/hghub.srs`。修改 JSON 后重新编译：

```sh
sing-box rule-set compile --output rules/hghub.srs rules/hghub.json
```

## IP/CIDR 与本地协议

`198.18.0.0/15` 是应用为兼容代理而允许的 FakeIP 地址池，不是上游服务专用网段。不能用它替代域名规则，也不要把共享 CDN 的 DNS 解析结果当作固定专用 CIDR。

`hg://localhost`、`hg.localhost`、`ipc.localhost`、`tauri.localhost` 是 WebView 内部协议；`localhost:1420` 是开发服务器，`127.0.0.1:7897` 是代理配置示例。它们均未加入远端代理规则。安全测试中的内网地址、示例域名，以及依赖下载、配置 schema、文档链接也未纳入。

如果代理日志只显示 IP，请先核对域名嗅探、FakeIP 映射恢复或应用使用系统 HTTP 代理的配置；无法恢复域名时，这份域名规则可能无法匹配。

格式参考：[Mihomo 规则集合](https://wiki.metacubex.one/config/rule-providers/)、[sing-box 源规则集](https://sing-box.sagernet.org/configuration/rule-set/source-format/)、[sing-box 路由迁移说明](https://sing-box.sagernet.org/migration/)。

## 本地验证

2026-11-10 更新后的检查：Mihomo v1.19.33 的 `-t` 校验引用 `rules/hghub.list` 的 `classical` + `text` rule-provider 配置通过；脚本核对 `.list` 与 `.json` 的 9 条目标完全一致。`.srs` 用 sing-box 1.14.4 重新编译，编译前做过往返验证——用同一版本编译修改前的 `hghub.json`，产物与仓库里已提交的 `.srs` 逐字节相同，说明新旧规则集出自同一工具链。编译后的 `.srs` 与源 `.json` 各通过 26 项 `rule-set match`（16 条应命中、10 条不应命中，反例含 `notdrleao.cn`、`xhuangguoai.com`、`adihsppe.cc.evil.example`、`8.8.8.8`），并以 `format: binary` 通过 `sing-box check`。验证用的二进制与临时文件都放在 `/tmp`，没有写入仓库，也没有改动本机代理配置。
