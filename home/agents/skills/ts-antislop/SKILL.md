---
name: ts-antislop
description: make sure the code has nothing the rules in https://github.com/dmmulroy/anti-slop reject
disable-model-invocation: true
---

make sure the code has nothing the rules in https://github.com/dmmulroy/anti-slop reject

if the repo already has anti-slop in its lint setup, run the repo's lint. otherwise keep one clone of anti-slop at `$TMPDIR/anti-slop` and run its rules from there. if the clone already exists, reuse it and update it with `git pull` instead of cloning again. do not install it in this repo
