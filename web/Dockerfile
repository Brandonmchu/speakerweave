# Adapted from every-react/Dockerfile.
#
# Railway trap this exists to avoid: Railway injects env at RUNTIME, but Vite
# bakes VITE_* at BUILD time. Every public var must be a Railway build-time
# variable AND an ARG here, or it silently bakes empty.
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# Build-time public config. Empty VITE_BACKEND_URL = same-origin, which is what
# the nginx /api + /public proxy below expects.
ARG VITE_BACKEND_URL=""
ENV VITE_BACKEND_URL=${VITE_BACKEND_URL}
ARG VITE_CLERK_PUBLISHABLE_KEY=""
ENV VITE_CLERK_PUBLISHABLE_KEY=${VITE_CLERK_PUBLISHABLE_KEY}

RUN npm run build

# --- serve ------------------------------------------------------------------
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html

# Fail the image build if a future base tag drops the standard module required
# by nginx/default.conf's `gzip_static on` directive.
RUN nginx -V 2>&1 | grep -q -- '--with-http_gzip_static_module'

# nginx:alpine runs envsubst over /etc/nginx/templates/*.template at startup.
# NGINX_ENVSUBST_FILTER restricts it to BACKEND_URL — without the filter,
# envsubst also eats nginx's own $uri/$host variables.
ENV NGINX_ENVSUBST_FILTER=BACKEND_URL
ENV BACKEND_URL=http://localhost:8000
COPY nginx/default.conf /etc/nginx/templates/default.conf.template

# SPA fallback for hosts that serve 404.html directly.
RUN cp /usr/share/nginx/html/index.html /usr/share/nginx/html/404.html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
