const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const app = express();

app.use(express.json());
// 开放 public 目录，所有的 html 前端文件都在这里
app.use(express.static(path.join(__dirname, 'public'))); 

// ==========================================
// --- 1. 数据库初始化 ---
// ==========================================
const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // 注册记录表
    db.run("CREATE TABLE IF NOT EXISTS registration (displayName TEXT, upn TEXT UNIQUE, time DATETIME)");
    // 系统机密配置表
    db.run("CREATE TABLE IF NOT EXISTS config (key TEXT UNIQUE, value TEXT)");
    // 管理员账号表
    db.run("CREATE TABLE IF NOT EXISTS admin_users (username TEXT UNIQUE, password TEXT)");
});

// 全局状态：系统是否已初始化
let isInitialized = false;

// 封装：从数据库读取当前配置的 Promise 函数
const getConfig = () => {
    return new Promise((resolve, reject) => {
        db.all("SELECT key, value FROM config", (err, rows) => {
            if (err) return reject(err);
            const conf = {};
            rows.forEach(row => conf[row.key] = row.value);
            resolve(conf);
        });
    });
};

// ==========================================
// --- 2. 中间件：强制初始化拦截 ---
// ==========================================
app.use(async (req, res, next) => {
    // 放行安装页面、安装接口和静态资源
    if (req.path === '/setup.html' || req.path === '/api/setup' || req.path.startsWith('/assets')) {
        return next();
    }

    if (!isInitialized) {
        db.get("SELECT value FROM config WHERE key = 'tenantId'", (err, row) => {
            if (!row) {
                // 如果数据库里没有配置，拦截请求并跳转到 setup.html
                if (req.xhr || req.headers.accept?.includes('json')) {
                    return res.status(403).json({ success: false, msg: '系统未初始化，请先配置', requireSetup: true });
                } else {
                    return res.redirect('/setup.html');
                }
            } else {
                isInitialized = true;
                next();
            }
        });
    } else {
        next();
    }
});

// ==========================================
// --- 3. 系统初始化 API (首次运行使用) ---
// ==========================================
app.post('/api/setup', (req, res) => {
    const { adminUser, adminPass, tenantId, clientId, clientSecret, skuId, inviteCode } = req.body;

    if (!tenantId || !clientId || !clientSecret) {
        return res.json({ success: false, msg: "Microsoft 365 核心机密信息不能为空" });
    }

    db.serialize(() => {
        // 保存管理员账号
        const stmtAdmin = db.prepare("INSERT OR REPLACE INTO admin_users (username, password) VALUES (?, ?)");
        stmtAdmin.run(adminUser, adminPass);
        stmtAdmin.finalize();

        // 保存各项配置
        const stmtConf = db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
        stmtConf.run('tenantId', tenantId);
        stmtConf.run('clientId', clientId);
        stmtConf.run('clientSecret', clientSecret);
        stmtConf.run('skuId', skuId || '6fd2c87f-b296-42f0-b197-1e91e994b900');
        stmtConf.run('inviteCode', inviteCode || 'schopenhauer'); 
        stmtConf.finalize();

        isInitialized = true; // 更新内存状态，释放拦截
        res.json({ success: true, msg: "系统初始化成功" });
    });
});

// ==========================================
// --- 4. 前台注册 API (主页使用) ---
// ==========================================

// 用户名实时查重接口
app.get('/api/check-username', (req, res) => {
    const { username, domain } = req.query;
    if (!username || !domain) return res.json({ available: false });
    
    const upn = `${username}@${domain}`;
    db.get("SELECT upn FROM registration WHERE upn = ?", [upn], (err, row) => {
        if (err) return res.status(500).json({ available: false, msg: "数据库异常" });
        res.json({ available: !row });
    });
});

// 核心注册逻辑
app.post('/api/register', async (req, res) => {
    const { username, password, displayName, inviteCode, domain } = req.body;
    const upn = `${username}@${domain}`;

    try {
        // 动态从数据库获取配置
        const conf = await getConfig();

        // 校验前台输入的邀请码是否和后台配置的一致
        if (inviteCode !== conf.inviteCode) {
            return res.json({ success: false, msg: "邀请码无效" });
        }

        // 1. 本地查重
        db.get("SELECT * FROM registration WHERE upn = ?", [upn], async (err, row) => {
            if (row) return res.json({ success: false, msg: "该用户名在本地已注册" });

            try {
                // 2. 获取 Token (使用数据库中的 conf)
                const tokenRes = await axios.post(`https://login.microsoftonline.com/${conf.tenantId}/oauth2/v2.0/token`, 
                    new URLSearchParams({
                        client_id: conf.clientId,
                        client_secret: conf.clientSecret,
                        grant_type: 'client_credentials',
                        scope: 'https://graph.microsoft.com/.default'
                    }));
                const token = tokenRes.data.access_token;

                // 3. 创建用户
                const userRes = await axios.post('https://graph.microsoft.com/v1.0/users', {
                    accountEnabled: true,
                    displayName: displayName || username,
                    mailNickname: username,
                    userPrincipalName: upn,
                    usageLocation: "CN", 
                    passwordProfile: { forceChangePasswordNextSignIn: true, password: password }
                }, { headers: { Authorization: `Bearer ${token}` } });

                const userId = userRes.data.id;

                // 4. 等待 5 秒确保云端同步
                await new Promise(resolve => setTimeout(resolve, 5000));

                // 5. 分配许可证
                if (conf.skuId) {
                    await axios.post(`https://graph.microsoft.com/v1.0/users/${userId}/assignLicense`, {
                        addLicenses: [{ skuId: conf.skuId }], 
                        removeLicenses: []
                    }, { headers: { Authorization: `Bearer ${token}` } });
                }

                // 6. 写入本地 DB
                db.run("INSERT INTO registration (displayName, upn, time) VALUES (?, ?, ?)", [displayName, upn, new Date().toISOString()]);
                
                res.json({ success: true });

            } catch (e) {
                console.error('微软通讯故障详情:', e.response?.data || e.message);
                const errorMsg = e.response?.data?.error?.message || '微软服务器拒绝了请求';
                res.json({ success: false, msg: errorMsg });
            }
        });
    } catch (dbErr) {
        res.json({ success: false, msg: "无法读取系统配置，请联系管理员" });
    }
});

// ==========================================
// --- 5. 管理后台专属 API (admin.html使用) ---
// ==========================================

// 管理员登录接口
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM admin_users WHERE username = ? AND password = ?", [username, password], (err, row) => {
        if (err || !row) {
            return res.json({ success: false, msg: "用户名或密码错误" });
        }
        // 简单签发一个基础 Token (Base64编码)
        const token = Buffer.from(`${username}:${password}`).toString('base64');
        res.json({ success: true, token: token });
    });
});

// 获取当前邀请码接口
app.get('/api/admin/config', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ success: false, msg: "未授权访问" });

    try {
        const conf = await getConfig();
        res.json({ success: true, inviteCode: conf.inviteCode });
    } catch (e) {
        res.json({ success: false, msg: "读取配置失败" });
    }
});

// 更新邀请码接口
app.post('/api/admin/config', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ success: false, msg: "未授权访问" });

    const { inviteCode } = req.body;
    if (!inviteCode) return res.json({ success: false, msg: "邀请码不能为空" });

    db.run("UPDATE config SET value = ? WHERE key = 'inviteCode'", [inviteCode], function(err) {
        if (err) return res.json({ success: false, msg: "数据库更新失败" });
        res.json({ success: true, msg: "系统邀请码已更新！" });
    });
});

// ==========================================
// 启动服务
// ==========================================
app.listen(3000, () => console.log('Microsoft 365 Automation Backend Running on port 3000'));