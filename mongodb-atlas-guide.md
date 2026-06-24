# MongoDB Atlas 注册指南（解决 Render 数据丢失问题）

## 问题原因
Render 免费版的文件系统是临时的，每次重新部署/重启，服务器上的 `db.json` 会被清空，导致账号需要重新注册。

## 解决方案：用 MongoDB Atlas（免费、数据永久保存）

---

## 第一步：注册 MongoDB Atlas

1. 打开 https://www.mongodb.com/cloud/atlas/register
2. 填邮箱、密码注册（或 Google/GitHub 登录）
3. 选 **Starter Cluster (Free)** → 下一步
4. **Cloud Provider & Region**：选 **AWS** + **Singapore (ap-southeast-1)**（离中国最近，速度快）
5. **Cluster Tier**：确认是 **M0 Sandbox (Free)**（512MB 免费额度，够用）
6. **Cluster Name**：填 `fire-ledger`（随便填也行）
7. 点 **Create Cluster**（创建需要 1-3 分钟）

---

## 第二步：创建数据库账号

1. 左侧菜单点 **Database Access** → **Add New Database User**
2. **Password** 方式：选 **Password**
   - Username：填 `fireuser`（随便）
   - Password：点 **Autogenerate Secure Password** → 复制保存好这个密码！
3. **Database User Privileges**：选 **Read and Write to Any Database**
4. 点 **Add User**

---

## 第三步：配置 IP 白名单（允许 Render 访问）

1. 左侧菜单点 **Network Access** → **Add IP Address**
2. 点 **Allow Access from Anywhere**（`0.0.0.0/0`）→ 点 **Confirm**

> ⚠️ 这样做任何 IP 都能访问（用密码保护），对免费应用够用。
> 更安全的方式是只填 Render 的 IP，但 Render 免费版 IP 不固定，所以只能允许所有 IP。

---

## 第四步：获取连接字符串

1. 回到 **Clusters** 页面（左侧 Database 菜单）
2. 点你刚创建的集群的 **Connect** 按钮
3. 选 **Drivers**
4. **Driver** 选 **Node.js**，**Version** 选 **6.0 or later**
5. 复制连接字符串，类似这样：
   ```
   mongodb+srv://fireuser:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
6. 把 `<password>` 替换成你在第二步生成的密码
7. 把 `/?` 前面加上数据库名，变成：
   ```
   mongodb+srv://fireuser:你的密码@cluster0.xxxxx.mongodb.net/fire_ledger?retryWrites=true&w=majority
   ```

**最终得到的就是 `MONGO_URI`**，保存好这个字符串。

---

## 第五步：把 MONGO_URI 填到 Render

1. 打开 https://dashboard.render.com
2. 点你的 `fire-ledger` 服务
3. 上方菜单点 **Environment**
4. 点 **Add Environment Variable**：
   - Key：`MONGO_URI`
   - Value：粘贴上面你得到的最终连接字符串
5. 点 **Save Changes**
6. 回到服务页面，点 **Manual Deploy** → **Deploy latest commit**
7. 等 2-3 分钟部署完成

---

## 完成后

- 数据永久保存在 MongoDB Atlas，Render 重启不会丢失
- 你和对象重新注册一次账号，之后数据永远在
- MongoDB Atlas 免费版 512MB，按你们两人的数据量可以用几十年

---

## 常见问题

**Q：密码忘了怎么办？**
A：去 MongoDB Atlas → Database Access → 编辑用户 → 改密码 → 更新 Render 的 MONGO_URI

**Q：Atlas 免费版够用吗？**
A：512MB，每条记账记录约 200 字节，可以存 250 万条，完全够用。

**Q：Render 部署失败怎么办？**
A：检查 MONGO_URI 是否正确，尤其密码里的特殊字符需要 URL 编码（如 `@` 变成 `%40`）
