{
  config,
  lib,
  pkgs,
  ...
}:

let
  # GitHub allows 60 unauthenticated API requests an hour, and `nix flake update`
  # makes one for each github: input. Activation writes the token, so it stays out
  # of the repo and the Nix store.
  accessTokens = "${config.xdg.configHome}/nix/access-tokens.conf";

  writeAccessTokens = pkgs.writeShellScript "write-nix-access-tokens" ''
    set -euo pipefail

    target=${lib.escapeShellArg accessTokens}

    # Remove the old token too. If GitHub revoked it, every GitHub request from
    # Nix fails.
    if ! token="$(${lib.getExe config.programs.gh.package} auth token --hostname github.com)" \
      || [[ -z "$token" ]]; then
      ${pkgs.coreutils}/bin/rm -f "$target"
      echo "warning: gh is not logged in to github.com, so Nix has no GitHub access token" >&2
      exit 0
    fi

    ${pkgs.coreutils}/bin/mkdir -p "$(${pkgs.coreutils}/bin/dirname "$target")"

    output="$(${pkgs.coreutils}/bin/mktemp "$target.XXXXXX")"
    trap '${pkgs.coreutils}/bin/rm -f "$output"' EXIT

    ${pkgs.coreutils}/bin/chmod 600 "$output"
    printf 'access-tokens = github.com=%s\n' "$token" > "$output"
    ${pkgs.coreutils}/bin/mv -f "$output" "$target"
  '';
in
{
  # Home Manager's nix.extraOptions needs nix.package, and Determinate Nix leaves
  # it null. So this module writes nix.conf directly. Nix skips the !include when
  # the file is missing.
  xdg.configFile."nix/nix.conf".text = ''
    !include ${accessTokens}
  '';

  home.activation.nixAccessTokens = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    run ${writeAccessTokens}
  '';
}
