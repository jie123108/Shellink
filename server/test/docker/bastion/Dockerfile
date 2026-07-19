FROM alpine:3.20

RUN apk add --no-cache \
    openssh-server \
    openssh-client \
    bash \
    python3 \
    openssl \
    expect \
    coreutils \
    iproute2 \
    iputils \
    && mkdir -p /var/run/sshd /home/testuser/.ssh /opt/bastion \
    && adduser -D -s /opt/bastion/menu.sh testuser \
    && echo 'testuser:testpass' | chpasswd \
    && ssh-keygen -A \
    && echo '/opt/bastion/menu.sh' >> /etc/shells

COPY test/fixtures/keys/authorized_keys /home/testuser/.ssh/authorized_keys
COPY test/docker/bastion/menu.sh /opt/bastion/menu.sh

RUN chown -R testuser:testuser /home/testuser/.ssh \
    && chmod 700 /home/testuser/.ssh \
    && chmod 600 /home/testuser/.ssh/authorized_keys \
    && chmod 755 /opt/bastion/menu.sh \
    && printf 'Host target\n  StrictHostKeyChecking no\n  UserKnownHostsFile=/dev/null\n' > /home/testuser/.ssh/config \
    && chown testuser:testuser /home/testuser/.ssh/config \
    && echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config \
    && echo 'PubkeyAuthentication yes' >> /etc/ssh/sshd_config

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
