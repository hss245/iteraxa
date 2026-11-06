#!/bin/sh
# Build and install Iteraxa from a clone of this repository.
#
#   ./install.sh          macOS: build with Homebrew and copy Iteraxa.app to ~/Applications
#                         Ubuntu: install build packages, build a .deb and install it
#   ./install.sh build    only build the app bundle (the Homebrew formula calls this)
#   ./install.sh check    run every test
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
cd "$ROOT"
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
unset CARGO_TARGET_DIR # bundles must land in ./target
VERSION=$(sed -n 's/^version = "\(.*\)"$/\1/p' app/Cargo.toml | head -n 1)

die() {
	echo "iteraxa: $*" >&2
	exit 1
}

build() {
	bundles="$1"
	triple=$(rustc -vV | sed -n 's/^host: //p')
	rm -rf app/binaries && mkdir -p app/binaries
	go build -trimpath -ldflags "-s -w -X iteraxa/internal/daemon.Version=$VERSION" -o "app/binaries/ixd-$triple" ./cmd/ixd
	cargo build --release -p ixpack
	cp target/release/ixpack "app/binaries/ixpack-$triple"
	if ! command -v cargo-tauri >/dev/null 2>&1; then
		cargo install tauri-cli --version "^2" --locked --root "$ROOT/target/tools"
		PATH="$ROOT/target/tools/bin:$PATH"
	fi
	(cd app && cargo tauri build --bundles "$bundles")
}

check() {
	# tauri-build refuses to compile the app until its sidecars exist; the tests never run them, and build()
	# replaces app/binaries with real ones.
	triple=$(rustc -vV | sed -n 's/^host: //p')
	mkdir -p app/binaries
	for b in ixd ixpack; do
		[ -e "app/binaries/$b-$triple" ] || : >"app/binaries/$b-$triple"
	done
	cargo test --workspace
	go vet ./...
	go test ./...
	PYTHONPATH=python python3 -m iteraxa.selfcheck
}

macos() {
	command -v brew >/dev/null 2>&1 || die "install Homebrew first (https://brew.sh), then run this again"
	for f in go rust python@3.13; do
		brew list --formula "$f" >/dev/null 2>&1 || brew install "$f"
	done

	# Homebrew builds from an archive, so pack the working tree (uncommitted changes included).
	mkdir -p target
	src="$ROOT/target/iteraxa-src.tar.gz"
	git ls-files -co --exclude-standard -z | tar --null -czf "$src" -T -
	sha=$(shasum -a 256 "$src" | cut -d ' ' -f 1)

	brew tap-new --no-git hss245/iteraxa >/dev/null 2>&1 || true
	tap=$(brew --repo hss245/iteraxa)
	mkdir -p "$tap/Formula"
	sed -e "s|@URL@|file://$src|" -e "s|@SHA256@|$sha|" -e "s|@VERSION@|$VERSION|" \
		packaging/homebrew/iteraxa.rb >"$tap/Formula/iteraxa.rb"
	brew trust hss245/iteraxa >/dev/null 2>&1 || true

	if brew list --formula hss245/iteraxa/iteraxa >/dev/null 2>&1; then
		brew reinstall --build-from-source hss245/iteraxa/iteraxa
	else
		brew install --build-from-source hss245/iteraxa/iteraxa
	fi

	mkdir -p "$HOME/Applications"
	rm -rf "$HOME/Applications/Iteraxa.app"
	ditto "$(brew --prefix)/opt/iteraxa/Iteraxa.app" "$HOME/Applications/Iteraxa.app"
	echo "Installed Iteraxa $VERSION. Open it from ~/Applications or Spotlight."
}

ubuntu() {
	command -v apt-get >/dev/null 2>&1 || die "this installer supports macOS and Ubuntu/Debian"
	sudo apt-get update
	sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev \
		libayatana-appindicator3-dev librsvg2-dev python3 git \
		bubblewrap socat # Claude Code's sandbox, used when a goal's network access is off
	# go.mod needs Go 1.22; older Ubuntu releases ship an older golang-go.
	if ! go version 2>/dev/null | grep -Eq 'go1\.(2[2-9]|[3-9][0-9])'; then
		sudo apt-get install -y golang-go || true
		if ! go version 2>/dev/null | grep -Eq 'go1\.(2[2-9]|[3-9][0-9])'; then
			sudo snap install go --classic
			PATH="/snap/bin:$PATH"
		fi
	fi
	# Ubuntu's packaged Rust is too old for Tauri 2.
	if ! command -v rustup >/dev/null 2>&1; then
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
	fi
	. "$HOME/.cargo/env"
	build deb
	sudo apt-get install -y "$ROOT"/target/release/bundle/deb/Iteraxa_"$VERSION"_*.deb
	echo "Installed Iteraxa $VERSION. Launch it from the app menu."
}

case "${1:-install}" in
build) build "$([ "$(uname -s)" = Darwin ] && echo app || echo deb)" ;;
check) check ;;
install) if [ "$(uname -s)" = Darwin ]; then macos; else ubuntu; fi ;;
*) die "usage: ./install.sh [build|check]" ;;
esac
