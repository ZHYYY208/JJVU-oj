// 站点品牌与头像配置（幂等，可重复执行，失败不阻塞启动）
// 1) 根域（system，路径 /）的默认名称是 "Hydro"，改为站点名
// 2) Gravatar 默认走 cn.gravatar.com（国内不可用），换成国内镜像
// 3) 域头像指向本地 logo，避免头像服务被墙导致破图
await SystemModel.set('avatar.gravatar_url', 'https://gravatar.loli.net/avatar/');
await DomainModel.edit('system', { name: 'JJVUoj', avatar: 'url:/jjyuoj-logo.png' });
await DomainModel.edit('jjyu', { avatar: 'url:/jjyuoj-logo.png' });
console.log('site-config-ok');
