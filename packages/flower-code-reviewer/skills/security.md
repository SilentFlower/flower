# 安全代码评审清单

> 当 MR 涉及 auth / login / crypto / secret / password / token 等敏感目录时启用。

## 认证 / 授权

- 鉴权是否在所有 endpoint 上(默认拒绝)
- 是否检查了"是这个用户"+"有权限做这件事"两层
- session / token 过期、刷新、撤销是否正确
- 越权场景(横向、纵向)是否考虑

## 凭据存储

- 密码必须哈希(bcrypt / argon2),不能可逆
- token / refresh token 不能进日志
- 密钥不能进代码 / git
- 数据库里敏感字段是否加密

## 输入安全

- SQL 必须参数化(零容忍)
- 命令注入(任何 exec / shell 拼接用户输入)
- 路径穿越(任何文件操作用户输入路径)
- SSRF(任何 fetch 用户输入 URL)
- 反序列化(yaml / pickle 等不安全格式)

## 输出安全

- 日志不能含敏感数据(密码、token、身份证、手机号)
- 错误响应不能泄露内部细节(堆栈、SQL、文件路径)
- 重定向不能信任用户输入的 URL

## 加密

- 不要自己实现密码学
- 用算法白名单:AES-GCM / ChaCha20-Poly1305 / Ed25519 / Argon2
- 不要 ECB、不要 MD5/SHA1 做 MAC、不要 DES

## 第三方依赖

- 新增依赖是否在团队 / 项目的依赖白名单
- 是否有已知 CVE(npm audit / mvn dependency-check)

## 这一项打 blocker 的标准

以下情况**必须**打 `blocker`,阻塞合并:
- 任何 SQL 注入风险
- 任何硬编码生产密钥
- 任何明显的越权漏洞
- 任何敏感数据落明文存储 / 明文传输
