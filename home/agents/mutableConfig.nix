{
  config,
  lib,
  pkgs,
}:

let
  mergeMutableJson = pkgs.writeShellScript "merge-mutable-json" ''
    set -euo pipefail

    target="$1"
    managed="$2"

    ${pkgs.coreutils}/bin/mkdir -p "$(${pkgs.coreutils}/bin/dirname "$target")"

    output="$(${pkgs.coreutils}/bin/mktemp "$target.XXXXXX")"
    trap '${pkgs.coreutils}/bin/rm -f "$output"' EXIT

    if [[ -s "$target" ]]; then
      ${lib.getExe pkgs.jq} \
        --sort-keys \
        --slurp '.[0] * .[1]' \
        "$target" \
        "$managed" \
        > "$output"
    else
      ${lib.getExe pkgs.jq} --sort-keys '.' "$managed" > "$output"
    fi

    ${pkgs.coreutils}/bin/chmod 600 "$output"
    ${pkgs.coreutils}/bin/mv -f "$output" "$target"

    trap - EXIT
  '';

  mergeMutableToml = pkgs.writeShellScript "merge-mutable-toml" ''
    set -euo pipefail

    target="$1"
    managed="$2"

    ${pkgs.coreutils}/bin/mkdir -p "$(${pkgs.coreutils}/bin/dirname "$target")"

    work="$(${pkgs.coreutils}/bin/mktemp -d)"
    output="$(${pkgs.coreutils}/bin/mktemp "$target.XXXXXX")"
    trap '${pkgs.coreutils}/bin/rm -rf "$work" "$output"' EXIT

    if [[ -s "$target" ]]; then
      ${lib.getExe pkgs.yj} -tj < "$target" > "$work/current.json"
    else
      printf '{}\n' > "$work/current.json"
    fi

    ${lib.getExe pkgs.yj} -tj < "$managed" > "$work/managed.json"
    ${mergeMutableJson} "$work/current.json" "$work/managed.json"
    ${lib.getExe pkgs.yj} -jt < "$work/current.json" > "$output"

    ${pkgs.coreutils}/bin/chmod 600 "$output"
    ${pkgs.coreutils}/bin/mv -f "$output" "$target"

    ${pkgs.coreutils}/bin/rm -rf "$work"
    trap - EXIT
  '';

  mutableConfig =
    merge:
    {
      name,
      file,
    }:
    let
      entry = config.home.file.${file};
    in
    {
      file.${file} = {
        enable = lib.mkForce false;
      };
      activation.${name} = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        run ${merge} \
          ${lib.escapeShellArg "${config.home.homeDirectory}/${entry.target}"} \
          ${lib.escapeShellArg (toString entry.source)}
      '';
    };

  mutableJson = mutableConfig mergeMutableJson;
  mutableToml = mutableConfig mergeMutableToml;
in
{
  inherit
    mutableJson
    mutableToml
    ;
}
