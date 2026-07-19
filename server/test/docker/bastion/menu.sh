#!/bin/bash
# Interactive bastion menu simulating jump-host options.
set -euo pipefail

export PS1='$ '

echo "========================================"
echo "  Shellink Test Bastion"
echo "========================================"
echo "1) Connect to target (direct)"
echo "2) Connect to target (with secondary password)"
echo "3) Connect to target (with OTP)"
echo "4) Confirm host key then connect"
echo "q) Quit"
echo -n "Select option: "
read -r choice

case "$choice" in
  1)
    echo "Connecting to target..."
    exec ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      testuser@target
    ;;
  2)
    echo -n "Secondary password: "
    read -r spw
    if [ "$spw" != "jump2pass" ]; then
      echo "Invalid secondary password"
      exit 1
    fi
    echo "OK, connecting..."
    exec ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      testuser@target
    ;;
  3)
    echo -n "OTP: "
    read -r otp
    if [ "$otp" != "123456" ]; then
      echo "Invalid OTP"
      exit 1
    fi
    echo "OTP accepted, connecting..."
    exec ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      testuser@target
    ;;
  4)
    echo "Are you sure you want to continue connecting (yes/no)?"
    read -r ans
    if [ "$ans" != "yes" ]; then
      echo "Aborted"
      exit 1
    fi
    exec ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      testuser@target
    ;;
  q|Q)
    exit 0
    ;;
  *)
    echo "Unknown option: $choice"
    exit 1
    ;;
esac
