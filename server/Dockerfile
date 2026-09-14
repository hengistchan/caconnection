FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

LABEL org.opencontainers.image.title="CA Connection Gateway" \
    org.opencontainers.image.version="0.2.0"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN useradd --system --uid 10001 --create-home gateway \
    && mkdir -p /var/lib/gateway/backups \
    && chown -R gateway:gateway /var/lib/gateway

WORKDIR /app
COPY requirements.txt /app/server/requirements.txt
RUN python -m pip install --no-cache-dir -r /app/server/requirements.txt
COPY __init__.py gateway_server.py backup_database.py restore_database.py \
    protocol_smoke.py /app/server/

USER gateway
EXPOSE 8787
VOLUME ["/var/lib/gateway"]

ENTRYPOINT ["python", "-m", "server.gateway_server"]
CMD ["--host", "0.0.0.0", "--port", "8787", "--viewer-port", "0", "--no-tls", "--config", "/run/secrets/gateway_config", "--database", "/var/lib/gateway/gateway.db"]
