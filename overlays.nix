inputs:

{
  awake = final: prev: {
    awake = inputs.awake.packages.${prev.stdenv.hostPlatform.system}.default;
  };

  helix = final: prev: {
    helix = inputs.helix.packages.${prev.stdenv.hostPlatform.system}.default;
  };

  llm-agents =
    final: prev:
    let
      packages = inputs.llm-agents.packages.${prev.stdenv.hostPlatform.system};

      version = "1.7.0";
      src = prev.runCommand "pi-src-with-lock" { } ''
        mkdir $out
        tar -xzf ${
          prev.fetchurl {
            url = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-${version}.tgz";
            hash = "sha512-opRelA1oqV/o+cByICMYU87oiHuICeCkghHMqsZsDwDz9F6qo8HFhoH4J/wZkr6tBeFor7ryOSwEmpZsusYrbA==";
          }
        } -C $out --strip-components=1
        cp ${./pi-package-lock.json} $out/package-lock.json
      '';
    in
    {
      llm-agents = packages // {
        # TODO: remove with pi-package-lock.json once llm-agents.nix has pi 1.7.0
        pi =
          assert prev.lib.assertMsg (prev.lib.versionOlder packages.pi.version version)
            "llm-agents.nix has pi ${packages.pi.version}, so remove the ${version} override";
          packages.pi.overrideAttrs {
            inherit version src;
            npmDeps = prev.fetchNpmDeps {
              inherit src;
              name = "pi-${version}-npm-deps";
              fetcherVersion = 2;
              hash = "sha256-D8qe0akPo23+BPJ3ZHBKPIi71rn7MzUuRpXH1Yal0f0=";
            };
          };
      };
    };

  unstable = final: prev: {
    unstable = import inputs.nixpkgs-unstable {
      inherit (prev.stdenv.hostPlatform) system;
      config.allowUnfree = true;
    };
  };
}
