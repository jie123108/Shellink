FROM alpine:3.20

RUN apk add --no-cache \
    openssh-server \
    bash \
    python3 \
    openssl \
    coreutils \
    iproute2 \
    iptables \
    && mkdir -p /var/run/sshd /home/testuser/.ssh \
    && adduser -D -s /bin/bash testuser \
    && echo 'testuser:testpass' | chpasswd \
    && echo 'root:rootpass' | chpasswd \
    && ssh-keygen -A

COPY test/fixtures/keys/authorized_keys /home/testuser/.ssh/authorized_keys
RUN chown -R testuser:testuser /home/testuser/.ssh \
    && chmod 700 /home/testuser/.ssh \
    && chmod 600 /home/testuser/.ssh/authorized_keys \
    && printf 'export PS1="$ "\n' >> /home/testuser/.bashrc \
    && printf 'export PS1="$ "\n' >> /root/.bashrc \
    && sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config \
    && echo 'PubkeyAuthentication yes' >> /etc/ssh/sshd_config \
    && echo 'PermitEmptyPasswords no' >> /etc/ssh/sshd_config

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
