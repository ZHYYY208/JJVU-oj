#!/bin/sh

# 只监听容器内部网络，供 hydrojudge 与 AI 出题插件调用，不对外暴露端口
pm2 start sandbox -- -http-addr 0.0.0.0:5050 -mount-conf /root/.hydro/mount.yaml
pm2-runtime start hydrojudge
