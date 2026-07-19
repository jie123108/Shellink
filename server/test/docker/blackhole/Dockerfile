FROM alpine:3.20

RUN apk add --no-cache socat

# Accept TCP connections but never speak SSH — clients hang until readyTimeout
EXPOSE 22
CMD ["socat", "TCP-LISTEN:22,fork,reuseaddr", "SYSTEM:sleep 3600"]
