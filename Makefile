# DeepSeek Harness Makefile
# 基于 README.md 的核心命令集

.PHONY: install build web stop all help

all: help

install:
	pnpm install

build:
	pnpm run build

web:
	pnpm dsh web

# 杀掉占用3080端口进程，macos / linux 兼容
stop:
	@echo "正在查找并杀死 3080 端口进程..."
	-lsof -i :3080 | grep LISTEN | awk '{print $$2}' | xargs kill -9 2>/dev/null || true
	@echo "3080 端口已清理完成"

help:
	@echo "可用命令:"
	@echo "  make install   - 安装项目依赖 (pnpm install)"
	@echo "  make build     - 构建项目产物 (pnpm run build)"
	@echo "  make web       - 启动 Web UI (pnpm dsh web)"
	@echo "  make stop      - 杀掉占用3080端口的进程"
