# Template. ./install.sh fills in @URL@, @SHA256@ and @VERSION@ from the working tree
# and installs it from the local tap hss245/iteraxa. The app is built from source here,
# so it is not quarantined and Gatekeeper lets it run without a Developer ID.
class Iteraxa < Formula
  desc "Desktop goal runner for Claude Code, Codex and Cursor"
  homepage "https://github.com/hss245/iteraxa"
  url "@URL@"
  sha256 "@SHA256@"
  version "@VERSION@"
  license "MIT"

  depends_on "go" => :build
  depends_on "rust" => :build
  depends_on :macos
  depends_on "python@3.13"

  def install
    system "./install.sh", "build"
    prefix.install "target/release/bundle/macos/Iteraxa.app"
    bin.write_exec_script prefix/"Iteraxa.app/Contents/MacOS/iteraxa"
  end

  def caveats
    "Iteraxa.app is in #{opt_prefix}; ./install.sh also copies it to ~/Applications."
  end

  test do
    assert_equal version.to_s, shell_output("#{prefix}/Iteraxa.app/Contents/MacOS/ixd version").strip
  end
end
