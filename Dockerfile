FROM node:22.14.0-slim

WORKDIR /app

# Install production dependencies deterministically
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy only runtime application files
COPY server.js plantnet.js groq.js supabase.js ./
COPY public ./public
COPY arduino/watermi_blynk/watermi_blynk.ino ./arduino/watermi_blynk/watermi_blynk.ino

# Prepare writable non-root data directory (used only in non-Supabase local mode)
RUN mkdir -p /data && chown -R node:node /app /data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
