{
  description = "haoxiangliew's nix configurations";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    nixpkgs-darwin.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    darwin = {
      url = "github:LnL7/nix-darwin/nix-darwin-26.05";
      inputs.nixpkgs.follows = "nixpkgs-darwin";
    };

    helix.url = "github:helix-editor/helix";
    llm-agents.url = "github:numtide/llm-agents.nix";
  };

  nixConfig = {
    extra-substituters = [
      "https://cache.numtide.com"
      "https://helix.cachix.org"
    ];
    extra-trusted-public-keys = [
      "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g="
      "helix.cachix.org-1:ejp9KQpR1FBI2onstMQ34yogDm4OgU2ru6lIwPvuCVs="
    ];
  };

  outputs =
    inputs@{
      nixpkgs,
      home-manager,
      darwin,
      ...
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      forEachSystem = nixpkgs.lib.genAttrs systems;

      overlays = import ./overlays.nix inputs;

      pkgsFor =
        system:
        import (if nixpkgs.lib.hasSuffix "-darwin" system then inputs.nixpkgs-darwin else nixpkgs) {
          inherit system;
          config.allowUnfree = true;
          overlays = builtins.attrValues overlays;
        };
    in
    {
      inherit overlays;

      formatter = forEachSystem (system: (pkgsFor system).nixfmt-tree);

      devShells = forEachSystem (
        system:
        let
          pkgs = pkgsFor system;

          flake = ''(builtins.getFlake "/var/home/haoxiangliew/Developer/nix")'';

          languages = (pkgs.formats.toml { }).generate "languages.toml" {
            language = [
              {
                name = "nix";
                auto-format = true;
                language-servers = [ "nixd" ];
              }
              {
                name = "markdown";
                language-servers = [
                  "marksman"
                  "mpls"
                ];
              }
            ];
            language-server = {
              nixd = {
                args = [ "--semantic-tokens=true" ];
                config.nixd = {
                  nixpkgs.expr =
                    if pkgs.stdenv.isDarwin then
                      "import ${flake}.inputs.nixpkgs-darwin { }"
                    else
                      "import ${flake}.inputs.nixpkgs { }";
                  options = {
                    darwin.expr = ''${flake}.darwinConfigurations."hao@fluidstack".options'';
                    home-manager.expr =
                      if pkgs.stdenv.isDarwin then
                        ''${flake}.darwinConfigurations."hao@fluidstack".options.home-manager.users.type.getSubOptions [ ]''
                      else
                        ''${flake}.homeConfigurations."haoxiangliew@hx-framework".options'';
                  };
                };
              };
              mpls = {
                command = "mpls";
                args = [
                  "--theme"
                  "dracula"
                  "--browser"
                  "helium"
                  "--enable-emoji"
                ];
              };
            };
          };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.bashInteractive
              pkgs.unstable.nixd
              pkgs.nixfmt
              pkgs.marksman
              pkgs.mpls
            ];
            shellHook = ''
              mkdir -p .helix
              ln -sf ${languages} .helix/languages.toml
            '';
          };
        }
      );

      darwinConfigurations."hao@fluidstack" = darwin.lib.darwinSystem {
        pkgs = pkgsFor "aarch64-darwin";
        modules = [
          home-manager.darwinModules.home-manager
          ./devices/fluidstack.nix
          ./darwin
          ./darwin/brew.nix
          {
            home-manager = {
              useGlobalPkgs = true;
              users.hao.imports = [
                ./home
                ./home/darwin.nix
                ./home/helix.nix
                ./home/agents.nix
                ./home/1password.nix
              ];
            };
          }
        ];
      };

      homeConfigurations."haoxiangliew@hx-framework" = home-manager.lib.homeManagerConfiguration {
        pkgs = pkgsFor "x86_64-linux";
        modules = [
          ./devices/framework.nix
          ./home
          ./home/silverblue.nix
          ./home/gnome.nix
          ./home/helix.nix
          ./home/agents.nix
          ./home/1password.nix
        ];
      };
    };
}
