import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import { constants, Device, eventTypes, UInput, NevEvent } from 'nevdev';
import { exec } from 'child_process';
// const writeFunction = nevdev.createDevice();
// console.log('writeFunction:', writeFunction);
const configFilePath = path.resolve(__dirname, '..', 'config', 'main.yaml');

interface KeyboardConfig {
  name: string;
  layout: string;
  keymap: string;
}

type Keymap = [string[], string[]][];
interface SimpleKeymap {
  modifiers: string[];
  commands: string[];
}
interface KeyDefinition {
  aliases: string[];
  keymaps: SimpleKeymap[];
}
interface LayoutConfig {
  /**
   * List of layout name to add.
   */
  compile?: string[];
  keymap: Keymap;
}
interface KeymapConfig {
  [name: string]: string[][];
}

interface Config {
  manifest_version: number;
  keymaps: KeymapConfig[];
  layouts: Record<string, LayoutConfig>;
  keyboards: KeyboardConfig[];
}

function getKeyboard(config: Config, name: string): KeyboardConfig | undefined {
  return config.keyboards.find((x) => x.name === name);
}
function getLayout(config: Config, name: string): LayoutConfig | undefined {
  for (const [layoutName, layout] of Object.entries(config.layouts)) {
    if (layoutName === name) {
      return layout;
    }
  }
}

enum KeyChangeState {
  RELEASE = 0,
  PRESS = 1,
  REPEAT = 2,
}
/**
 * Encaplusale key RELEASE and PRESS for more expressive statements.
 */
const keyChangeBinaryState = new Set([KeyChangeState.RELEASE, KeyChangeState.PRESS]);

const execUID = 1000;
const execGID = 1000;

// interface CompiledMapping {
//   [key: string]: {
//     modifiers: string[];
//     commands: string[];
//   };
// }

function compileKeymap(config: Config, activeLayers: string[]): Record<string, KeyDefinition> {
  const compiledLayouts = new Set<string>();
  const layoutToCompile = [...activeLayers];
  const keysDefinitions: Record<string, KeyDefinition> = {};
  let currentLayoutName: string;

  while ((currentLayoutName = layoutToCompile.pop())) {
    const layoutNamesToCompile = config.layouts[currentLayoutName].compile;
    if (layoutNamesToCompile?.length) {
      layoutToCompile.push(
        ...layoutNamesToCompile.filter(
          (x) => !compiledLayouts.has(x) && config.layouts[currentLayoutName],
        ),
      );
    }
    compiledLayouts.add(currentLayoutName);
    for (const [keyGroup, commands] of config.layouts[currentLayoutName].keymap) {
      const modifiers = [...keyGroup];
      const key = modifiers.pop();

      // Remapping of virtual keys
      const keyDefinition: KeyDefinition = keysDefinitions[key] || { aliases: [], keymaps: [] };

      const commandWithoutAliases: string[] = [];
      // TODO catch error in a nice way to not stop the remapping
      if (commands.some((x) => x.startsWith('@'))) {
        if (modifiers.length > 0) {
          throw new Error(
            'It is currently not supported to map keys with modifiers to virtual keys.',
          );
        }
        for (const command of commands) {
          if (command.startsWith('@')) {
            keyDefinition.aliases.push(command);
          } else {
            commandWithoutAliases.push(command);
          }
        }
      } else {
        commandWithoutAliases.push(...commands);
      }

      const keymap: SimpleKeymap = { modifiers, commands: commandWithoutAliases };
      keyDefinition.keymaps.push(keymap);
      keysDefinitions[key] = keyDefinition;
    }
  }
  return keysDefinitions;
}

const keyStates: Record<string, boolean> = {};
const layerState: Record<string, boolean> = {};
/**
 * In case we active a layer, increment a counter for a particular key.
 * It is possbile that multiples logic activate the same layer at the same time.
 * The number represent how many different logic currently activate the.
 */
const preventKey: Record<string, number> = {};
const defaultDeviceName = 'GoaTouch virtual device';

(async () => {
  const config = yaml.safeLoad(fs.readFileSync(configFilePath, 'utf-8')) as Config;
  const devices = await Device.all();
  const uinput = new UInput(defaultDeviceName);

  for (const device of devices) {
    const keyboardConfig = getKeyboard(config, device.name);
    if (!keyboardConfig) continue;

    console.log();
    console.log('--------------------');
    console.log('name::', device.name);
    // console.log('keyboardConfig:', keyboardConfig);
    // console.log('layout', config.layouts);
    const layout = getLayout(config, keyboardConfig.layout);
    if (!layout) {
      throw new Error(
        `Layout ${keyboardConfig.layout} does not exits.\nCreate an entry or use another layout in you config.yaml`,
      );
    }
    device.listen();
    device.grab();
    const activeLayers = Object.entries(layerState)
      .map(([layerName, state]) => layerName && state && layerName)
      .filter((layerName) => !!layerName);
    let compiledKeymap = compileKeymap(config, [keyboardConfig.layout, ...activeLayers]);

    device.on('event', (event) => {
      // if (event.value !== KeyChangeState.REPEAT) console.log('layerState:', layerState);

      const type = eventTypes[event.type];
      const linuxKeyNames = type.events[event.code];
      if (type.name === 'EV_KEY') {
        // console.log('event:', event);
        const keyNames = new Set<string>();
        const currentKeymaps: SimpleKeymap[] = [];

        const visitedKeys = new Set<string>();
        const visitStack = [...linuxKeyNames];
        let currentKey: string;
        // const definitions: KeyDefinition[] = [];
        // console.log('visitStack:', visitStack);
        // console.log(
        //   'compiledKeymap:',
        //   Object.keys(compiledKeymap).map((key) => ({
        //     ...compiledKeymap[key],
        //     key: key,
        //     keymaps: JSON.stringify(compiledKeymap[key].keymaps),
        //   })),
        // );
        while ((currentKey = visitStack.shift())) {
          keyNames.add(currentKey);
          visitedKeys.add(currentKey);
          const keyDefinition = compiledKeymap[currentKey];
          if (!keyDefinition) continue;
          // definitions.push(keyDefinition);
          for (const alias of keyDefinition.aliases) {
            if (!visitedKeys.has(alias)) {
              visitStack.push(alias);
            }
          }
          // console.log('keyDefinition:', keyDefinition);
          currentKeymaps.push(...keyDefinition.keymaps);
        }
        // console.log('compiledKeymap:', compiledKeymap);

        for (const keyName of keyNames) {
          keyStates[keyName] = !!event.value;
        }

        if (event.value !== KeyChangeState.REPEAT) {
          console.log('---');
          for (const [key, state] of Object.entries(keyStates)) {
            if (state) console.log(`key ${key}`, true);
          }
        }

        if (event.value !== KeyChangeState.REPEAT) {
          // console.log('event.value:', event.value);
          // console.log('keyNames:', keyNames);
          // console.log('currentKeymaps:', currentKeymaps);
        }
        let commandFound = false;
        for (const keymap of currentKeymaps) {
          if (keymap.commands.length && keymap.modifiers.every((m) => keyStates[m])) {
            commandFound = true;

            for (const command of keymap.commands) {
              // check if command is conssidedred as a key remapping
              console.log('command:', command);
              let match: RegExpMatchArray;
              if (command.match(/^\s*\w+\s*$/)) {
                //if (event.value === KeyChangeState.REPEAT) continue;
                const key = command.trim();
                console.log('changing command to ', key);
                const code = constants[command.trim().toUpperCase()];
                const nevEvent = {
                  type: constants['EV_KEY'],
                  code: code,
                  value: event.value,
                };
                uinput.write(nevEvent);
                uinput.sync();
                // check if we want to run a shell command
              } else if (
                (match = command.match(/^\s*>(.*)/)) &&
                event.value === KeyChangeState.PRESS
              ) {
                const shellCommand = match[1];
                console.log('calling a sub process:');
                console.log(shellCommand);
                exec(
                  shellCommand,
                  { uid: execUID, gid: execGID },
                  // (error, stdout, stderr) => {
                  //   console.log('############################################');
                  //   console.log('result of command: ', command);
                  //   if (error) {
                  //     console.log('error:');
                  //     console.log(error);
                  //     console.log('');
                  //   }
                  //   console.log('stdout:');
                  //   console.log(stdout);
                  //   console.log('');
                  //   if (stderr) {
                  //     console.log('stderr:');
                  //     console.log(stderr);
                  //     console.log('');
                  //   }
                  //   console.log('############################################');
                  // },
                );

                // check if we want to activate/deactivate a layer
              } else if ((match = command.match(/^\s*#(.*)/))) {
                if (event.value === KeyChangeState.REPEAT) continue;
                // if (!keyChangeBinaryState.has(event.value)) continue;
                const layerName = match[1].trim();
                layerState[layerName] = !!event.value;
                compiledKeymap = compileKeymap(config, [keyboardConfig.layout, ...activeLayers]);

                // preventKey[event.code] = preventKey[event.code] || 0;
                // preventKey[event.code] += event.value ? KeyChangeState.PRESS : -1;
              }
            }
            break;
          }
        }
        if (!commandFound) {
          uinput.write(event);
          uinput.sync();
        }
        // uinput.write(event);
        // uinput.sync();
      }
    });
    // console.log('layout:', layout);
    // console.log('keymap:', keymap);
    // console.log('--------------------');
    // console.log('name::', device.name);
    // console.log('phys::', device.phys);
    // console.log('id_product::', device.id_product);
    // console.log('id_vendor::', device.id_vendor);
    // console.log('id_bustype::', device.id_bustype);
    // console.log('id_version::', device.id_version);
    // console.log('driver_version::', device.driver_version);
  }
})();
