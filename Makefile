# DeepSeek Harness Makefile
# 基于 README.md 的核心命令集

.PHONY: install build web all help

all: help

install:
	pnpm install

build:
	pnpm run build

web:
	pnpm dsh web

help:
	@echo "可用命令:"
	@echo "  make install   - 安装项目依赖 (pnpm install)"
	@echo "  make build     - 构建项目产物 (pnpm run build)"
	@echo "  make web       - 启动 Web UI (pnpm dsh web)"
