FROM alpine:3.20

RUN apk add --no-cache bash python3 openssl coreutils \
    && adduser -D -s /bin/bash testuser \
    && printf 'export PS1="$ "\n' >> /home/testuser/.bashrc \
    && printf 'export PS1="$ "\n' >> /root/.bashrc

WORKDIR /home/testuser
CMD ["sleep", "infinity"]
