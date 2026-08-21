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
    nix-index-database.url = "github:nix-community/nix-index-database";
    pstack = {
      url = "github:cursor/plugins";
      flake = false;
    };

    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  nixConfig = {
    extra-substituters = [
      "https://nix-community.cachix.org"
      "https://cache.numtide.com"
      "https://helix.cachix.org"
    ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g="
      "helix.cachix.org-1:ejp9KQpR1FBI2onstMQ34yogDm4OgU2ru6lIwPvuCVs="
    ];
  };

  outputs =
    inputs@{
      self,
      nixpkgs,
      nixpkgs-darwin,
      home-manager,
      darwin,
      treefmt-nix,
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
        import (if nixpkgs.lib.hasSuffix "-darwin" system then nixpkgs-darwin else nixpkgs) {
          inherit system;
          config.allowUnfree = true;
          overlays = builtins.attrValues overlays;
        };

      treefmtFor =
        system:
        let
          pkgs = pkgsFor system;
        in
        treefmt-nix.lib.evalModule pkgs {
          projectRootFile = "flake.nix";
          programs = {
            nixfmt.enable = true;
            shellcheck.enable = true;
            shfmt.enable = true;
          };
          settings.formatter.shellcheck.excludes = [ "*.envrc" ];
        };
    in
    {
      inherit overlays;

      formatter = forEachSystem (system: (treefmtFor system).config.build.wrapper);

      checks = {
        aarch64-darwin.fluidstack = self.darwinConfigurations."hao@fluidstack".system;
        x86_64-linux.hx-framework = self.homeConfigurations."haoxiangliew@hx-framework".activationPackage;
      };

      devShells = forEachSystem (
        system:
        let
          pkgs = pkgsFor system;

          flake = ''(builtins.getFlake "@flakePath@")'';

          languages = (pkgs.formats.toml { }).generate "languages.toml" {
            language = [
              {
                name = "nix";
                auto-format = true;
                language-servers = [ "nixd" ];
              }
            ];
            language-server = {
              nixd = {
                config.nixd = {
                  nixpkgs.expr =
                    if pkgs.stdenv.hostPlatform.isDarwin then
                      "import ${flake}.inputs.nixpkgs-darwin { }"
                    else
                      "import ${flake}.inputs.nixpkgs { }";
                  options = {
                    darwin.expr = ''${flake}.darwinConfigurations."hao@fluidstack".options'';
                    home-manager.expr =
                      if pkgs.stdenv.hostPlatform.isDarwin then
                        ''${flake}.darwinConfigurations."hao@fluidstack".options.home-manager.users.type.getSubOptions [ ]''
                      else
                        ''${flake}.homeConfigurations."haoxiangliew@hx-framework".options'';
                  };
                };
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
            ];
            shellHook = ''
              mkdir -p .helix
              rm -f .helix/languages.toml
              substitute ${languages} .helix/languages.toml \
                --replace-fail '@flakePath@' "$PWD"
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
              extraSpecialArgs = { inherit inputs; };
              users.hao.imports = [
                inputs.nix-index-database.homeModules.default
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
        extraSpecialArgs = { inherit inputs; };
        modules = [
          inputs.nix-index-database.homeModules.default
          ./devices/framework.nix
          ./home
          ./home/silverblue.nix
          ./home/gnome.nix
          ./home/captive-portal
          ./home/helix.nix
          ./home/agents.nix
          ./home/1password.nix
        ];
      };
    };
}
