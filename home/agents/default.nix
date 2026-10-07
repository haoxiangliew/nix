{
  pkgs,
  lib,
  config,
  # osConfig,
  inputs,
  ...
}:

let
  pkgsOf =
    packages: name: path:
    lib.listToAttrs (
      map (p: lib.nameValuePair name (path p)) (lib.filter (p: (p.pname or "") == name) packages)
    );

  skills = lib.mkMerge [
    (pkgsOf config.home.packages "herdr" (p: "${p.src}/skills/herdr"))
    (pkgsOf config.home.packages "tuicr" (p: "${p.src}/skills/tuicr"))
    (pkgsOf config.programs.gh.extensions "gh-stack" (p: "${p.src}/skills/gh-stack"))
    {
      unslop = "${inputs.pstack}/pstack/skills/unslop";
      technical-writing = "${inputs.pstack}/pstack/skills/technical-writing";
    }
  ];

  integrations = pkgsOf config.home.packages "herdr" lib.id;

  talkPrompt = "You are a read-only agent that works through code changes with the user. Inspect and reason about the codebase, but never modify, create, or delete files, whether with edit tools or with shell commands that write to disk. When you propose a change, write the complete updated code in your response so the user can review it, give feedback, and apply it. Refine your proposal from their replies instead of finalizing edits yourself. Never claim to have edited a file, and never try to.";

  herdrAgents = {
    claude-code = {
      target = "claude";
      after = [ "mergeClaudeCodeSettings" ];
    };
    codex = {
      target = "codex";
      after = [ "mergeCodexSettings" ];
    };
    opencode = {
      target = "opencode";
      after = [
        "mergeOpenCodeSettings"
        "mergeOpenCodeTuiSettings"
      ];
    };
    pi-coding-agent = {
      target = "pi";
      after = [ "mergePiSettings" ];
    };
  };

  # hasCask = name: lib.any (cask: cask.name == name) (osConfig.homebrew.casks or [ ]);

  mutableConfig = import ./mutableConfig.nix { inherit config lib pkgs; };
in

{
  # TODO: drop once programs.pi-coding-agent lands in the home-manager release branch
  imports = [ "${inputs.home-manager-master}/modules/programs/pi-coding-agent.nix" ];

  options.programs =
    lib.recursiveUpdate
      (lib.genAttrs (lib.attrNames herdrAgents) (
        lib.const {
          integrations.herdr = lib.mkOption {
            type = lib.types.nullOr lib.types.package;
            default = null;
            description = "Herdr package whose agent integration is installed during activation.";
          };
        }
      ))
      {
        pi-coding-agent = {
          skills = lib.mkOption {
            type = lib.types.attrsOf lib.types.path;
            default = { };
            description = "Skill directories linked into the pi agent skills directory.";
          };
          extensions = lib.mkOption {
            type = lib.types.attrsOf lib.types.path;
            default = { };
            description = "Extension files or directories linked into the pi agent extensions directory.";
          };
          themes = lib.mkOption {
            type = lib.types.attrsOf lib.types.path;
            default = { };
            description = "Theme JSON files linked into the pi agent themes directory, keyed by theme name.";
          };
        };
      };

  config = {
    home = lib.mkMerge [
      {
        sessionVariables = {
          # https://code.claude.com/docs/en/memory#enable-or-disable-auto-memory
          CLAUDE_CODE_DISABLE_AUTO_MEMORY = true;
          # https://code.claude.com/docs/en/agent-teams
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = true;
          # https://opencode.ai/docs/cli/#experimental
          OPENCODE_EXPERIMENTAL_PLAN_MODE = true;
          OPENCODE_EXPERIMENTAL_CODE_MODE = true;
          OPENCODE_EXPERIMENTAL_LSP_TOOL = true;
          OPENCODE_EXPERIMENTAL_OXFMT = true;
          OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = true;
          OPENCODE_EXPERIMENTAL_WEBSOCKETS = true;
        };
        packages = with pkgs.llm-agents; [
          grok
          herdr
          tuicr
        ];
      }
      (mutableConfig.mutableJson {
        name = "mergeClaudeCodeSettings";
        file = "${config.programs.claude-code.configDir}/settings.json";
      })
      (mutableConfig.mutableToml {
        name = "mergeCodexSettings";
        file = ".codex/config.toml";
      })
      (mutableConfig.mutableJson {
        name = "mergeOpenCodeSettings";
        file = "${config.xdg.configHome}/opencode/opencode.json";
      })
      (mutableConfig.mutableJson {
        name = "mergeOpenCodeTuiSettings";
        file = "${config.xdg.configHome}/opencode/tui.json";
      })
      (mutableConfig.mutableJson {
        name = "mergePiSettings";
        file = "${config.programs.pi-coding-agent.configDir}/settings.json";
      })
      {
        file."${config.programs.pi-coding-agent.configDir}/skills".source =
          pkgs.linkFarm "pi-skills" config.programs.pi-coding-agent.skills;
      }
      {
        file = lib.concatMapAttrs (name: source: {
          "${config.programs.pi-coding-agent.configDir}/extensions/${name}".source = source;
        }) config.programs.pi-coding-agent.extensions;
      }
      {
        file = lib.concatMapAttrs (name: source: {
          "${config.programs.pi-coding-agent.configDir}/themes/${name}.json".source = source;
        }) config.programs.pi-coding-agent.themes;
      }
      {
        file."${config.programs.pi-coding-agent.configDir}/extensions/pi-permission-system/config.json".source =
          (pkgs.formats.json { }).generate "pi-permission-system.json" {
            shellTools =
              lib.genAttrs
                [
                  "bg_task"
                  "bg_task_spawn"
                  "bg_task_watch"
                ]
                (
                  lib.const {
                    commandArgument = "command";
                    workdirArgument = "cwd";
                  }
                );
            authorizerChain = [ "auto-mode" ];
            # tier 3: everything else asks, and the reviewer decides
            permission = {
              # tier 1: read-only tools
              read = "allow";
              grep = "allow";
              find = "allow";
              ls = "allow";
              bg_task_list = "allow";
              bg_task_status = "allow";
              bg_task_log = "allow";
              get_subagent_result = "allow";
              get_search_content = "allow";
              ask_user_question = "allow";
              web_enable = "allow";

              # tier 2: in-project writes. external_directory sends writes outside the project to review
              edit = "allow";
              write = "allow";

              # tier 1: read-only commands. Never add interpreters or package-manager scripts, which run arbitrary code
              bash = {
                "git status*" = "allow";
                "git diff*" = "allow";
                "git log*" = "allow";
                "git show*" = "allow";
                "cd *" = "allow";
                "ls" = "allow";
                "ls *" = "allow";
                "pwd" = "allow";
                "rg *" = "allow";
                "cat *" = "allow";
                "head *" = "allow";
                "tail *" = "allow";
                "wc *" = "allow";
                "rg *--pre*" = "ask";
              };

              external_directory = {
                "/tmp/*" = "allow";
                "/private/tmp/*" = "allow";
                "/var/folders/*" = "allow";
                "/private/var/folders/*" = "allow";
                "*/.herdr/worktrees/*" = "allow";
              };
              external_directory_read."*" = "allow";

              # credential files go to the reviewer, even from read-only tools
              path = {
                "*" = "allow";
                "*.env" = "ask";
                "*.env.*" = "ask";
                "*.env.example" = "allow";
                "*.pem" = "ask";
                "*.key" = "ask";
                "~/.ssh/*" = "ask";
                "~/.aws/*" = "ask";
                "~/.kube/*" = "ask";
                "~/.gnupg/*" = "ask";
                "~/.docker/config.json" = "ask";
                "~/.config/gh/hosts.yml" = "ask";
                "${config.programs.pi-coding-agent.configDir}/auth.json" = "ask";
              };
            };
          };
      }
      {
        file."${config.programs.pi-coding-agent.configDir}/web-search.json".source =
          (pkgs.formats.json { }).generate "web-search.json"
            {
              provider = "openai";
              webSearch.allowedProviders = [ "openai" ];
              openaiSearchModel = "gpt-6.1-sol";
              youtube.enabled = false;
              video.enabled = false;
              commands = lib.genAttrs [
                "websearch"
                "curator"
                "search"
                "google-account"
              ] (lib.const { enabled = false; });
            };
      }
      {
        activation = lib.mkMerge (
          lib.mapAttrsToList (
            name: agent:
            let
              cfg = config.programs.${name};
            in
            {
              "installHerdrIntegration-${name}" = lib.mkIf (cfg.enable && cfg.integrations.herdr != null) (
                lib.hm.dag.entryAfter ([ "linkGeneration" ] ++ agent.after) ''
                  run ${lib.getExe cfg.integrations.herdr} integration install ${agent.target}
                ''
              );
            }
          ) herdrAgents
        );
      }
    ];

    xdg.configFile."herdr/config.toml".source = (pkgs.formats.toml { }).generate "herdr-config.toml" {
      onboarding = false;
      theme.name = "dracula";
      worktrees.directory = "~/Developer/.herdr/worktrees";
      ui = {
        toast.delivery = "terminal";
        sound.enabled = false;
        show_agent_labels_on_pane_borders = true;
      };
      update.version_check = false;
      keys = {
        move_tab_previous = "prefix+shift+h";
        move_tab_next = "prefix+shift+l";
        command = [
          {
            key = "prefix+t";
            type = "shell";
            description = "Move pane to a new tab";
            command = ''herdr pane move "$HERDR_ACTIVE_PANE_ID" --new-tab --focus'';
          }
          {
            key = "prefix+m";
            type = "shell";
            description = "Merge tab into the previous tab";
            command = ''
              w=$HERDR_ACTIVE_WORKSPACE_ID t=$HERDR_ACTIVE_TAB_ID
              to=$(herdr tab list --workspace "$w" | ${lib.getExe pkgs.jq} -r --arg t "$t" '.result.tabs | sort_by(.number) | .[(map(.tab_id) | index($t)) - 1].tab_id')
              [ "$to" = "$t" ] && exit
              herdr pane list --workspace "$w" | ${lib.getExe pkgs.jq} -r --arg t "$t" '.result.panes[] | select(.tab_id == $t) | .pane_id' |
                while read -r p; do herdr pane move "$p" --tab "$to" --split right --no-focus; done
              herdr tab focus "$to"
            '';
          }
        ];
      };
    };

    programs = {
      mcp.enable = true;
      claude-code = {
        enable = true;
        # generates a home-manager plugin with `.mcp.json` and wraps claude with `--plugin-dir`
        enableMcpIntegration = true;
        package = pkgs.llm-agents.claude-code;
        settings = {
          theme = "auto";
          tui = "fullscreen";
          permissions.defaultMode = "auto";
          outputStyle = "Concise";
          showThinkingSummaries = true;
          promptSuggestionEnabled = true;
          attribution = {
            commit = "";
            pr = "";
            sessionUrl = false;
          };
        };
        inherit skills integrations;
      };
      codex = {
        enable = true;
        enableMcpIntegration = true;
        package = pkgs.llm-agents.codex;
        settings = {
          approvals_reviewer = "auto_review";
          model_context_window = 1000000;
          model_auto_compact_token_limit = 900000;
          tui = {
            status_line = [
              "model-with-reasoning"
              "current-dir"
              "context-window-size"
              "used-tokens"
              "context-used"
              "pull-request-number"
            ];
            status_line_use_colors = true;
          };
        };
        inherit skills integrations;
      };
      opencode = {
        enable = true;
        enableMcpIntegration = true;
        package = pkgs.llm-agents.opencode;
        settings = {
          provider.openai.models = {
            "gpt-6-astra".limit = {
              context = 1050000;
              input = 922000;
              output = 128000;
            };
            "gpt-6-astra-fast".limit = {
              context = 1050000;
              input = 922000;
              output = 128000;
            };
          };
        };
        agents = {
          talk = ''
            ---
            description: Read-only agent for iterating on code with the user
            mode: primary
            permission:
              edit: deny
            ---

            ${talkPrompt}
          '';
        };
        tui = lib.mkMerge [
          {
            theme = "system";
            scroll_acceleration = {
              enabled = true;
            };
            attention = {
              enabled = true;
              sound = false;
            };
          }
          (lib.mkIf (config.programs.opencode.integrations.herdr != null) {
            plugin = [ "./herdr-tui-session.js" ];
          })
        ];
        inherit skills integrations;
      };
      pi-coding-agent = {
        enable = true;
        package = pkgs.llm-agents.pi;
        settings = {
          theme = "light/dracula-pro";
          transport = "websocket";
          terminal.showTerminalProgress = true;
          enableInstallTelemetry = false;
          # use bun as npm. pi's update check calls `npm view`, so run that as `bun info`
          npmCommand = [
            (lib.getExe (
              pkgs.writeShellScriptBin "bun" ''
                if [ "$1" = view ]; then
                  shift
                  tmp=$(mktemp -d)
                  trap 'rm -rf "$tmp"' EXIT
                  cd "$tmp"
                  echo '{}' > package.json
                  ${lib.getExe pkgs.bun} info "$@"
                else
                  exec ${lib.getExe pkgs.bun} "$@"
                fi
              ''
            ))
          ];
          warnings.anthropicExtraUsage = false;
          cacheWarming = "idle";
          showCacheMissNotices = true;
          talk.prompt = talkPrompt;
          mcpAncestors.roots = [ "~/Developer" ];
          packages = [
            "npm:pi-web-access"
            "npm:@gotgenes/pi-subagents"
            "npm:pi-better-background-tasks"
            "npm:@gotgenes/pi-permission-system"
            "npm:pi-pigment"
            "npm:@juicesharp/rpiv-ask-user-question"
            "npm:@narumitw/pi-btw"
            "npm:pi-rewind-hook"
          ];
        };
        models.providers = {
          openai.modelOverrides = lib.genAttrs [
            "gpt-6-astra"
            "gpt-6-luna"
            "gpt-6-sol"
            "gpt-6.1-sol"
          ] (lib.const { contextWindow = 922000; });
          openai-codex.modelOverrides = lib.genAttrs [
            "gpt-6-astra"
            "gpt-6-luna"
            "gpt-6-sol"
            "gpt-6.1-sol"
          ] (lib.const { contextWindow = 872000; });
        };
        keybindings = {
          "app.thinking.cycle" = "ctrl+t";
          "app.thinking.toggle" = "ctrl+shift+t";
        };
        themes.dracula-pro = ./pi/src/themes/dracula-pro.json;
        extensions = {
          "lib" = ./pi/src/lib;
          "talk.ts" = ./pi/src/talk.ts;
          "fast.ts" = ./pi/src/fast.ts;
          "anthropic-billing.ts" = ./pi/src/anthropic-billing.ts;
          "statusline.ts" = ./pi/src/statusline.ts;
          "skill-mention.ts" = ./pi/src/skill-mention.ts;
          "attention.ts" = ./pi/src/attention.ts;
          "auto-mode.ts" = ./pi/src/auto-mode.ts;
          "compaction.ts" = ./pi/src/compaction.ts;
          "stream-watchdog.ts" = ./pi/src/stream-watchdog.ts;
          "mcp-ancestors.ts" = ./pi/src/mcp-ancestors.ts;
          "review.ts" = "${
            pkgs.applyPatches {
              name = "pi-review";
              src = inputs.pi-review;
              patches = [ ./pi/patches/pi-review.patch ];
            }
          }/review.ts";
        };
        inherit skills integrations;
      };
    };
  };
}
