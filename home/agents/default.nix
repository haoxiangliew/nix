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
      map (p: lib.nameValuePair name (path p)) (lib.filter (p: lib.getName p == name) packages)
    );

  # pi runs herdr agents with its own tools, from pi/src/herdr-agents.ts, instead of the herdr skill.
  skills = lib.mkMerge [
    (pkgsOf config.home.packages "herdr" (p: "${p.src}/skills/herdr"))
    piSkills
  ];

  piSkills = lib.mkMerge [
    (pkgsOf config.programs.gh.extensions "gh-stack" (p: "${p.src}/skills/gh-stack"))
    {
      unslop = "${inputs.pstack}/pstack/skills/unslop";
      technical-writing = "${inputs.pstack}/pstack/skills/technical-writing";
      review-check = ./skills/review-check;
      ts-antislop = ./skills/ts-antislop;
      draft-pr-review = ./skills/draft-pr-review;
      prose-unslop = pkgs.linkFarm "prose-unslop" {
        "SKILL.md" = ./skills/prose-unslop/SKILL.md;
        "references/unslop.md" = "${inputs.pstack}/pstack/skills/unslop/SKILL.md";
      };
    }
  ];

  integrations =
    pkgsOf config.home.packages "herdr" lib.id // pkgsOf config.home.packages "rex" lib.id;

  # Rex.app ships its CLI inside the server bundle it updates. Rex adds that directory to PATH, but
  # nix-darwin's set-environment replaces PATH when fish starts.
  rex = pkgs.writeShellScriptBin "rex" ''
    exec "''${REX_BIN_DIR:-$HOME/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS}/rex" "$@"
  '';

  rexSessionHook = pkgs.writeShellApplication {
    name = "rex-session-hook";
    runtimeInputs = [ pkgs.jq ];
    text = builtins.readFile ./rex-session-hook.sh;
  };

  rexSessionHooks = agent: {
    SessionStart = lib.optionals pkgs.stdenv.isDarwin [
      {
        hooks = [
          {
            type = "command";
            command = "${lib.getExe rexSessionHook} ${agent}";
          }
        ];
      }
    ];
  };

  # Rex.app may not be installed, so a failed Rex setup warns instead of failing activation.
  installIntegration = {
    herdr = exe: target: "run ${exe} integration install ${target}";
    rex = exe: target: ''
      run ${exe} --autostart=false skill setup --agent ${target} --session-naming \
        || warnEcho "Couldn't set up Rex for ${target}"
    '';
  };

  # Versions and hashes come from bun.lock, so `bun update` bumps runtime packages too.
  npmPackage =
    name:
    let
      # bun.lock has trailing commas, which builtins.fromJSON rejects
      lock = builtins.fromJSON (
        lib.concatMapStrings (part: if builtins.isList part then builtins.head part else part) (
          builtins.split ",([[:space:]]*[]}])" (builtins.readFile ./pi/bun.lock)
        )
      );
      entry = lock.packages.${name};
      version = lib.removePrefix "${name}@" (builtins.elemAt entry 0);
      # A scoped package's tarball and store path use the name without its scope.
      tarball = pkgs.fetchurl {
        url = "https://registry.npmjs.org/${name}/-/${baseNameOf name}-${version}.tgz";
        hash = builtins.elemAt entry 3;
      };
    in
    pkgs.runCommand "${baseNameOf name}-${version}" { } ''
      mkdir $out
      tar -xzf ${tarball} -C $out --strip-components=1
    '';

  # Keep real paths together so imports still find node_modules after following HM symlinks.
  piExtensions = pkgs.runCommand "pi-extensions" { } ''
    mkdir -p "$out"
    ${lib.concatMapAttrsStringSep "\n" (name: source: ''
      mkdir -p "$out"/${lib.escapeShellArg (dirOf name)}
      cp -rL ${lib.escapeShellArg "${source}"} "$out"/${lib.escapeShellArg name}
    '') config.programs.pi-coding-agent.extensions}
  '';

  # pi-better-background-tasks with upstream PR #460, so a subagent can't hide this session's tasks
  # or stop their completion messages. Drop the patch once #460 ships. pi loads a local package
  # without installing it, so its dependencies go in its node_modules.
  backgroundTasks = pkgs.runCommand "pi-better-background-tasks" { } ''
    cp -r ${
      pkgs.applyPatches {
        name = "pi-better-background-tasks";
        src = npmPackage "pi-better-background-tasks";
        patches = [ ./pi/patches/pi-better-background-tasks.patch ];
      }
    } $out
    chmod -R u+w $out
    mkdir $out/node_modules
    ${lib.concatMapStringsSep "\n" (name: "cp -r ${npmPackage name} $out/node_modules/${name}") [
      "proper-lockfile"
      "graceful-fs"
      "retry"
      "signal-exit"
    ]}
  '';

  # pi-subagents with Explore on the Haiku family instead of Haiku 4.5, and fuzzy model names that
  # pick the newest version on a tie. Its imports are all ones pi provides, so it needs no
  # node_modules.
  subagents = pkgs.applyPatches {
    name = "pi-subagents";
    src = npmPackage "@gotgenes/pi-subagents";
    patches = [ ./pi/patches/pi-subagents.patch ];
  };

  talkPrompt = "Help the user without changing any files. You can read files and run commands, but don't run commands that create, edit, or delete files. Suggest changes instead of making them.";

  integrationAgents = {
    claude-code = {
      target = "claude";
      after = [ "mergeClaudeCodeSettings" ];
    };
    codex = {
      target = "codex";
      after = [
        "mergeCodexSettings"
        "mergeCodexHooks"
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
  # TODO: remove once the home-manager release branch includes programs.pi-coding-agent
  imports = [ "${inputs.home-manager-master}/modules/programs/pi-coding-agent.nix" ];

  options.programs =
    lib.recursiveUpdate
      (lib.genAttrs (lib.attrNames integrationAgents) (
        lib.const {
          integrations = lib.genAttrs (lib.attrNames installIntegration) (
            name:
            lib.mkOption {
              type = lib.types.nullOr lib.types.package;
              default = null;
              description = "${name} package whose agent integration home-manager installs during activation.";
            }
          );
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
          # https://pi.dev/docs/latest/environment-variables
          PI_CACHE_RETENTION = "long";
        };
        packages = [
          pkgs.llm-agents.herdr
        ]
        ++ lib.optional pkgs.stdenv.isDarwin rex;
      }
      (mutableConfig.mutableJson {
        name = "mergeClaudeCodeSettings";
        file = "${config.programs.claude-code.configDir}/settings.json";
      })
      (mutableConfig.mutableToml {
        name = "mergeCodexSettings";
        file = ".codex/config.toml";
      })
      {
        file.".codex/hooks.json".text = builtins.toJSON { hooks = rexSessionHooks "codex"; };
      }
      (mutableConfig.mutableJson {
        name = "mergeCodexHooks";
        file = ".codex/hooks.json";
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
        file = lib.listToAttrs (
          map (
            name:
            lib.nameValuePair "${config.programs.pi-coding-agent.configDir}/extensions/${name}" {
              source = "${piExtensions}/${name}";
            }
          ) (lib.attrNames config.programs.pi-coding-agent.extensions)
        );
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
                  "herdr_run"
                  "rex_run"
                ]
                (
                  lib.const {
                    commandArgument = "command";
                    workdirArgument = "cwd";
                  }
                );
            authorizerChain = [ "auto-mode" ];
            # tier 3: anything not listed here goes to the reviewer
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
              subagent = "allow";
              steer_subagent = "allow";
              get_search_content = "allow";
              ask_user_question = "allow";
              web_enable = "allow";
              skill = "allow";

              # tier 2: writes inside the project. external_directory sends writes outside it to the reviewer
              edit = "allow";
              write = "allow";

              # tier 1: read-only commands. don't add interpreters or package scripts, which can run any code
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
                "grep *" = "allow";
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
                "*/.rex/worktrees/*" = "allow";
                "/nix/store/*" = "allow";
              };
              external_directory_read."*" = "allow";

              # the reviewer checks credential files, even for read-only tools
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
      # Reload init.lua without starting Rex. A stopped server is normal; other failures still warn.
      (lib.mkIf pkgs.stdenv.isDarwin {
        activation.reloadRexConfig = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
          reloadRexConfig() {
            local output status=0
            output=$(run ${lib.getExe rex} --autostart=false config reload 2>&1) || status=$?

            # Rex uses exit 4 for this case. Match the diagnostic too, not all connection failures.
            if [[ $status -eq 4 &&
              $output == "Error: no Rex server is running at "*", and autostart is disabled" &&
              $output != *$'\n'* ]]; then
              return 0
            fi

            if [[ -n $output ]]; then
              if [[ $status -eq 0 ]]; then
                printf '%s\n' "$output"
              else
                printf '%s\n' "$output" >&2
              fi
            fi
            return "$status"
          }
          reloadRexConfig || warnEcho "Couldn't reload Rex's configuration"
        '';
      })
      {
        activation = lib.concatMapAttrs (
          name: agent:
          let
            cfg = config.programs.${name};
          in
          lib.concatMapAttrs (
            integration: install:
            let
              package = cfg.integrations.${integration};
            in
            lib.optionalAttrs (cfg.enable && package != null) {
              "install${lib.toSentenceCase integration}Integration-${name}" = lib.hm.dag.entryAfter (
                [ "linkGeneration" ] ++ agent.after
              ) (install (lib.getExe package) agent.target);
            }
          ) installIntegration
        ) integrationAgents;
      }
    ];

    xdg.configFile."rex" = lib.mkIf pkgs.stdenv.isDarwin {
      source = ./rex;
      recursive = true;
    };
    # agent_resume.json holds agent_resume.lua's settings.
    xdg.configFile."rex/agent_resume.json" = lib.mkIf pkgs.stdenv.isDarwin {
      source = (pkgs.formats.json { }).generate "rex-agent-resume.json" {
        # the Rex server's PATH has no rex
        rex = lib.getExe rex;
      };
    };
    # worktree.json holds worktree.lua's settings.
    xdg.configFile."rex/worktree.json" = lib.mkIf pkgs.stdenv.isDarwin {
      source = (pkgs.formats.json { }).generate "rex-worktree.json" {
        directory = "~/Developer/.rex/worktrees";
        # the Rex server's PATH has only the system's git
        git = lib.getExe config.programs.git.package;
      };
    };

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
          hooks = rexSessionHooks "claude";
        };
        inherit skills integrations;
      };
      codex = {
        enable = true;
        enableMcpIntegration = true;
        package = pkgs.llm-agents.codex;
        settings = {
          approvals_reviewer = "auto_review";
          features.daemon_auto_start = false;
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
      pi-coding-agent = {
        enable = true;
        package = pkgs.llm-agents.pi;
        settings = {
          theme = "light/dracula-pro";
          transport = "websocket";
          terminal.showTerminalProgress = true;
          showHardwareCursor = true;
          markdown.mermaid = "off";
          enableInstallTelemetry = false;
          # use bun as npm. pi's update check runs `npm view`, so this runs `bun info` instead
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
          rewind.silentCheckpoints = true;
          # hides the Rex skill that Codex's integration puts in ~/.agents/skills, which pi reads by
          # default. pi runs Rex agents with its own tools, from pi/src/rex.ts.
          skills = [ "-${config.home.homeDirectory}/.agents/skills/rex" ];
          packages = [
            "npm:pi-web-access"
            "${subagents}"
            "${backgroundTasks}"
            "npm:@gotgenes/pi-permission-system"
            "npm:pi-pigment"
            "npm:@juicesharp/rpiv-ask-user-question"
            "npm:@narumitw/pi-btw"
            "npm:pi-rewind-hook"
            "npm:pi-context-view"
            "${./pi/src/prompt-sections.ts}"
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
          "herdr-agents.ts" = ./pi/src/herdr-agents.ts;
          "rex.ts" = ./pi/src/rex.ts;
          "rex-resume.ts" = ./pi/src/rex-resume.ts;
          "auto-mode.ts" = ./pi/src/auto-mode.ts;
          "compaction.ts" = ./pi/src/compaction.ts;
          "mcp-ancestors.ts" = ./pi/src/mcp-ancestors.ts;
          "mermaid.ts" = ./pi/src/mermaid.ts;
          "super-review.ts" = ./pi/src/super-review.ts;
          "node_modules/acorn" = npmPackage "acorn";
          "node_modules/iced-x86" = npmPackage "iced-x86";
          "node_modules/lovely-mermaid" = npmPackage "lovely-mermaid";
          "review.ts" = "${
            pkgs.applyPatches {
              name = "pi-review";
              src = inputs.pi-review;
              patches = [ ./pi/patches/pi-review.patch ];
            }
          }/review.ts";
        };
        integrations = removeAttrs integrations [ "rex" ];
        skills = piSkills;
      };
    };
  };
}
