FROM node:22-bookworm

ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV NPM_CONFIG_REGISTRY=$NPM_REGISTRY

RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --registry=$NPM_REGISTRY \
      pm2 hydrooj@5.0.7 @hydrooj/ui-default@4.58.5 @hydrooj/fps-importer@1.6.0

COPY entrypoint.sh /root/entrypoint.sh
RUN chmod +x /root/entrypoint.sh

COPY seed /root/seed

ENTRYPOINT ["/root/entrypoint.sh"]
