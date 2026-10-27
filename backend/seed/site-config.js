// 站点品牌与头像配置（幂等，可重复执行，失败不阻塞启动）
// 1) 根域（system，路径 /）的默认名称是 "Hydro"，改为站点名
// 2) 头像一律走本地、不访问任何外网：Gravatar 请求重定向到本站 /jjyuoj-avatar/:hash 路由
// 3) 域头像指向本地 logo
await SystemModel.set('avatar.gravatar_url', '/jjyuoj-avatar/');
await DomainModel.edit('system', { name: 'JJVUoj', avatar: 'url:/jjyuoj-logo.png' });
await DomainModel.edit('jjyu', { avatar: 'url:/jjyuoj-logo.png' });
console.log('site-config-ok');
