FROM node:22-bookworm

ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG GO_JUDGE_MIRROR=https://gh-proxy.com/https://github.com/criyle/go-judge/releases/download/v1.9.4

ENV NPM_CONFIG_REGISTRY=$NPM_REGISTRY

RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      gcc g++ python3 openjdk-17-jdk-headless curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --registry=$NPM_REGISTRY pm2 @hydrooj/hydrojudge@4.0.6

RUN curl -fL --retry 3 --max-time 300 "$GO_JUDGE_MIRROR/go-judge_1.9.4_linux_amd64v3" -o /usr/bin/sandbox \
 && chmod +x /usr/bin/sandbox \
 && ln -sf /usr/local/bin/node /usr/bin/node \
 && sandbox -version

COPY entrypoint.sh /root/entrypoint.sh
RUN chmod +x /root/entrypoint.sh

ENTRYPOINT ["/root/entrypoint.sh"]
