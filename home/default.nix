{ pkgs, ... }:

{
  home = {
    username = "haoxiangliew";
    stateVersion = "26.05";
    packages = with pkgs; [
      nerd-fonts.jetbrains-mono
      nerd-fonts.symbols-only
      font-awesome
      material-design-icons
      unstable.podman-tui
    ];
  };

  fonts.fontconfig = {
    enable = true;
    defaultFonts.monospace = [ "JetBrainsMono Nerd Font" ];
  };

  news.display = "silent";

  programs = {
    fastfetch.enable = true;
    fd.enable = true;
    home-manager.enable = true;
    jq.enable = true;
    ripgrep.enable = true;
    ssh.enable = true;
    yazi.enable = true;
    delta = {
      enable = true;
      enableGitIntegration = true;
      enableJujutsuIntegration = true;
    };
    direnv = {
      enable = true;
      enableFishIntegration = true;
      nix-direnv.enable = true;
    };
    eza = {
      enable = true;
      enableFishIntegration = true;
      icons = "auto";
      extraOptions = [
        "--group-directories-first"
        "--header"
      ];
    };
    fish = {
      enable = true;
      shellInit = ''
        fish_add_path --global --prepend $HOME/.nix-profile/bin
      '';
    };
    git = {
      enable = true;
      lfs.enable = true;
      settings = {
        user = {
          name = "Hao Xiang Liew";
          email = "haoxiangliew@gmail.com";
        };
        core.ignoreCase = false;
        init.defaultBranch = "master";
        push.autoSetupRemote = true;
        pull.rebase = true;
        rebase.autoStash = true;
      };
    };
    ghostty = {
      enable = true;
      enableBashIntegration = true;
      enableFishIntegration = true;
      enableZshIntegration = true;
      settings = {
        font-family = "JetBrainsMono Nerd Font";
        font-size = 10;

        font-thicken = true;

        window-padding-x = 10;
        window-padding-y = 10;
        window-padding-balance = true;

        theme = "dark:dracula-pro,light:dracula-alucard";
        window-colorspace = "display-p3";

        shell-integration-features = "cursor,sudo,title,ssh-terminfo,ssh-env";

        mouse-hide-while-typing = true;

        macos-titlebar-style = "tabs";
      };
      themes = {
        dracula-pro = {
          palette = [
            "0=#22212C"
            "1=#FF9580"
            "2=#8AFF80"
            "3=#FFFF80"
            "4=#9580FF"
            "5=#FF80BF"
            "6=#80FFEA"
            "7=#F8F8F2"
            "8=#504C67"
            "9=#FFAA99"
            "10=#A2FF99"
            "11=#FFFF99"
            "12=#AA99FF"
            "13=#FF99CC"
            "14=#99FFEE"
            "15=#FFFFFF"
          ];
          background = "#22212C";
          foreground = "#F8F8F2";
          cursor-color = "#7970A9";
          cursor-text = "#7970A9";
          selection-background = "#454158";
          selection-foreground = "#F8F8F2";
        };
        dracula-alucard = {
          palette = [
            "0=#F5F5F5"
            "1=#CB3A2A"
            "2=#14710A"
            "3=#846E15"
            "4=#644AC9"
            "5=#A3144D"
            "6=#036A96"
            "7=#1F1F1F"
            "8=#FFFFFF"
            "9=#D74C3D"
            "10=#198D0C"
            "11=#9E841A"
            "12=#7862D0"
            "13=#BF185A"
            "14=#047FB4"
            "15=#2C2B31"
          ];
          background = "#F5F5F5";
          foreground = "#1F1F1F";
          cursor-color = "#635D97";
          cursor-text = "#635D97";
          selection-background = "#CFCFDE";
          selection-foreground = "#1F1F1F";
        };
      };
    };
    lazygit = {
      enable = true;
      enableFishIntegration = true;
      settings = {
        disableStartupPopups = true;
        promptToReturnFromSubprocess = false;
        git = {
          overrideGpg = true;
          pagers = [
            {
              pager = "delta --dark --paging=never --line-numbers --hyperlinks --hyperlinks-file-link-format=\"lazygit-edit://{path}:{line}\"";
            }
          ];
        };
        gui = {
          showRandomTip = false;
          nerdFontsVersion = "3";
        };
      };
    };
    neovim = {
      enable = true;
      viAlias = true;
      vimAlias = true;
      vimdiffAlias = true;
    };
    starship = {
      enable = true;
      enableFishIntegration = true;
    };
  };
}
