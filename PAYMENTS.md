# 微信 / 支付宝 App 支付接入

## 商品与价格

人民币商品只由服务端 `/src/routes/payments.js` 的 `PRODUCTS` 定义：

| productId | 到账 | 价格 |
| --- | ---: | ---: |
| `huan_yu_60` | 幻玉 ×60 | ¥6.00 |
| `huan_yu_300` | 幻玉 ×300 | ¥28.00 |
| `huan_yu_600` | 幻玉 ×600 | ¥52.00 |

客户端不能提交金额或到账数量，只能提交 `productId` 和支付渠道。

## 已实现的接口

- `POST /api/payments/orders`：鉴权后创建微信或支付宝订单。
- `GET /api/payments/status/:orderId`：查询订单是否已由支付平台确认到账。
- `POST /api/payments/wechat/notify`：微信支付 API v3 签名校验、AES-GCM 解密和幂等发货。
- `POST /api/payments/alipay/notify`：支付宝 RSA2 验签和幂等发货。

只有支付平台签名回调通过后，订单才会变为 `credited`。客户端查询到该状态后才会给本地幻玉钱包入账。

## 服务端配置

复制 `.env.example` 中的支付配置并填写：

- 微信：开放平台移动应用 AppID、商户号、商户证书序列号、商户私钥、API v3 密钥、微信支付平台证书及证书序列号。
- 支付宝：应用 AppID、应用私钥、支付宝公钥。
- `PAYMENT_NOTIFY_BASE_URL`：支付平台可以访问的公网 HTTPS 地址。

微信支付回调地址：

```text
https://你的域名/api/payments/wechat/notify
```

支付宝回调地址：

```text
https://你的域名/api/payments/alipay/notify
```

MongoDB 生产环境需要使用支持事务的副本集，保证“订单置为已支付”和“发放幻玉”处于同一事务。

## Android 客户端

官方 SDK AAR 已放在：

- `Assets/Plugins/Android/wechat-sdk-android-6.8.34.aar`
- `Assets/Plugins/Android/alipaysdk-android-15.8.35.aar`

还需要在微信开放平台和支付宝开放平台登记当前 Android 包名及签名 SHA-256。正式包启用混淆后，按官方文档保留支付 SDK 所需规则。

当前游戏内支付要求使用手机号、微信或 QQ 登录；游客身份不能创建人民币订单。

## 联调前检查

1. 服务端部署到公网 HTTPS 域名，并把域名写入 `PAYMENT_NOTIFY_BASE_URL`。
2. Android 包名、签名、微信 AppID 和支付宝 AppID 必须与开放平台登记一致。
3. 微信商户证书序列号、平台证书和 API v3 密钥必须来自同一个商户号。
4. 使用平台沙箱或最小金额商品完成“支付成功、取消支付、回调重放、重复通知”四类测试。
5. 不能用客户端返回结果直接发货，发货依据只能是服务端已验证的回调。
