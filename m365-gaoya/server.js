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
    // 系统机密配置表 (注意：使用 INSERT OR REPLACE 来确保 key 唯一)
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
// --- 2. 中间件：强制初始化拦截与安全防御 ---
// ==========================================
app.use(async (req, res, next) => {
    // 静态资源永远放行
    if (req.path.startsWith('/assets')) return next();

    if (isInitialized) {
        // 【防御】一旦初始化成功，绝对禁止任何人再次访问安装页面，直接踢回管理后台
        if (req.path === '/setup.html' || req.path === '/setup' || req.path === '/api/setup') {
            return res.redirect('/admin');
        }
        return next();
    }

    // 去数据库确认是否真的未初始化
    db.get("SELECT value FROM config WHERE key = 'tenantId'", (err, row) => {
        if (!row) {
            // 真没初始化，只放行安装路径
            if (req.path === '/setup.html' || req.path === '/api/setup' || req.path === '/setup') {
                return next();
            }
            if (req.xhr || req.headers.accept?.includes('json')) {
                return res.status(403).json({ success: false, msg: '系统未初始化，请先配置', requireSetup: true });
            } else {
                return res.redirect('/setup');
            }
        } else {
            isInitialized = true; // 更新内存状态
            // 已经初始化了却还想访问 setup，踢回后台
            if (req.path === '/setup.html' || req.path === '/setup' || req.path === '/api/setup') {
                return res.redirect('/admin');
            }
            next();
        }
    });
});

// ==========================================
// --- 3. 系统初始化 API (首次运行使用) ---
// ==========================================
app.post('/api/setup', (req, res) => {
    // 【防御】后端接口也要拒绝二次初始化
    if (isInitialized) {
        return res.status(403).json({ success: false, msg: "系统已初始化，禁止重复配置" });
    }

    // 接收新增的 siteName 和 allowedDomains
    const { adminUser, adminPass, tenantId, clientId, clientSecret, skuId, inviteCode, siteName, allowedDomains } = req.body;

    if (!tenantId || !clientId || !clientSecret) {
        return res.json({ success: false, msg: "Microsoft 365 核心机密信息不能为空" });
    }

    db.serialize(() => {
        // 保存管理员账号
        const stmtAdmin = db.prepare("INSERT OR REPLACE INTO admin_users (username, password) VALUES (?, ?)");
        stmtAdmin.run(adminUser, adminPass);
        stmtAdmin.finalize();

        // 保存各项配置 (包含新增的站点显示配置)
        const stmtConf = db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
        stmtConf.run('tenantId', tenantId);
        stmtConf.run('clientId', clientId);
        stmtConf.run('clientSecret', clientSecret);
        stmtConf.run('skuId', skuId || '6fd2c87f-b296-42f0-b197-1e91e994b900');
        stmtConf.run('inviteCode', inviteCode || 'schopenhauer'); 
        stmtConf.run('siteName', siteName || 'Microsoft 365 自动化管理');
        stmtConf.run('allowedDomains', allowedDomains || ''); // 存入如 "tuv.edu.kg, m365.pro"
        stmtConf.finalize();

        isInitialized = true; // 锁定安装门
        res.json({ success: true, msg: "系统初始化成功" });
    });
});

// ==========================================
// --- 4. 前台公共配置 API (供首页 index.html 动态渲染) ---
// ==========================================
app.get('/api/pub-config', async (req, res) => {
    try {
        const conf = await getConfig();
        res.json({
            success: true,
            siteName: conf.siteName || 'Microsoft 365',
            // 将字符串转为数组，并过滤空格
            domains: (conf.allowedDomains || '').split(',').map(d => d.trim()).filter(d => d)
        });
    } catch (e) {
        res.json({ success: false, msg: "读取配置失败" });
    }
});

// ==========================================
// --- 5. 前台注册 API (主页使用) ---
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
        const conf = await getConfig();
        if (inviteCode !== conf.inviteCode) {
            return res.json({ success: false, msg: "邀请码无效" });
        }

        db.get("SELECT * FROM registration WHERE upn = ?", [upn], async (err, row) => {
            if (row) return res.json({ success: false, msg: "该用户名在本地已注册" });

            try {
                const tokenRes = await axios.post(`https://login.microsoftonline.com/${conf.tenantId}/oauth2/v2.0/token`, 
                    new URLSearchParams({
                        client_id: conf.clientId,
                        client_secret: conf.clientSecret,
                        grant_type: 'client_credentials',
                        scope: 'https://graph.microsoft.com/.default'
                    }));
                const token = tokenRes.data.access_token;

                const userRes = await axios.post('https://graph.microsoft.com/v1.0/users', {
                    accountEnabled: true,
                    displayName: displayName || username,
                    mailNickname: username,
                    userPrincipalName: upn,
                    usageLocation: "CN", 
                    passwordProfile: { forceChangePasswordNextSignIn: true, password: password }
                }, { headers: { Authorization: `Bearer ${token}` } });

                const userId = userRes.data.id;
                await new Promise(resolve => setTimeout(resolve, 5000));

                if (conf.skuId) {
                    await axios.post(`https://graph.microsoft.com/v1.0/users/${userId}/assignLicense`, {
                        addLicenses: [{ skuId: conf.skuId }], 
                        removeLicenses: []
                    }, { headers: { Authorization: `Bearer ${token}` } });
                }

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
// --- 6. 管理后台专属 API ---
// ==========================================

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM admin_users WHERE username = ? AND password = ?", [username, password], (err, row) => {
        if (err || !row) return res.json({ success: false, msg: "用户名或密码错误" });
        const token = Buffer.from(`${username}:${password}`).toString('base64');
        res.json({ success: true, token: token });
    });
});

app.get('/api/admin/config', async (req, res) => {
    if (!req.headers.authorization) return res.status(401).json({ success: false, msg: "未授权访问" });
    try {
        const conf = await getConfig();
        // 修改：现在连同 siteName 和 allowedDomains 一起返回给 admin.html
        res.json({ 
            success: true, 
            inviteCode: conf.inviteCode,
            siteName: conf.siteName || '',
            allowedDomains: conf.allowedDomains || ''
        });
    } catch (e) { res.json({ success: false, msg: "读取配置失败" }); }
});

app.post('/api/admin/config', (req, res) => {
    if (!req.headers.authorization) return res.status(401).json({ success: false, msg: "未授权访问" });
    
    // 修改：支持接收三个字段的更新
    const { inviteCode, siteName, allowedDomains } = req.body;
    if (!inviteCode) return res.json({ success: false, msg: "邀请码不能为空" });

    db.serialize(() => {
        const stmt = db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
        stmt.run('inviteCode', inviteCode);
        stmt.run('siteName', siteName || 'Microsoft 365 自动化管理');
        stmt.run('allowedDomains', allowedDomains || '');
        stmt.finalize();
        
        res.json({ success: true, msg: "系统配置已完美更新！" });
    });
});

// ==========================================
// --- 路由美化 ---
// ==========================================
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/home', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('*', (req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ==========================================
// 启动服务
// ==========================================
app.listen(3000, () => console.log('Microsoft 365 Automation Backend Running on port 3000'));
