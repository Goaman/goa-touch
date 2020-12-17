import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import { constants, Device, eventTypes, UInput, NevEvent } from 'nevdev';
import { exec } from 'child_process';

const configFilePath = path.resolve(__dirname, '..', 'config', 'main.yaml');

interface KeyboardConfig {
  name: string;
  layout: string;
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

const execUID = 1000;
const execGID = 1000;

// interface CompiledMapping {
//   [key: string]: {
//     modifiers: string[];
//     commands: string[];
//   };
// }

// fs.watch(

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
  // for (const definition of Object.values(keysDefinitions)) {
  //   definition.keymaps = definition.keymaps.reverse();
  // }
  return keysDefinitions;
}

const keyStates: Record<string, boolean> = {};
const layerState: Record<string, boolean> = {};
/**
 * A map of keycode that must be released when a particural code is pressed.
 *
 * For instance, if a key has been remaped in a particular layer, if the key is
 * not released before releasing the layer, storing the key to release is
 * required.
 */
const remapToRelease: Record<number, Set<number>> = {};

const defaultDeviceName = 'GoaTouch virtual device';

class Remapper {
  config: Config;
  uinput: UInput;
  loadedDevices: Device[] = [];
  allDevices: Device[];

  async start() {
    this.config = yaml.safeLoad(fs.readFileSync(configFilePath, 'utf-8')) as Config;
    this.uinput = new UInput(defaultDeviceName);
    await this.loadDevices();
    await this.bind();
    this.listenConfigChange();
  }
  async getDevicesInConfig() {
    return this.allDevices.filter((d) => !!getKeyboard(this.config, d.name));
  }
  async loadDevices() {
    this.allDevices = await Device.all();
  }
  async bind() {
    for (const device of this.allDevices) {
      const keyboardConfig = getKeyboard(this.config, device.name);
      if (!keyboardConfig) continue;

      console.log('Remapping device:', device.name);
      console.log('Main layer:', keyboardConfig.layout);
      this.loadedDevices.push(device);
      const layout = getLayout(this.config, keyboardConfig.layout);
      if (!layout) {
        throw new Error(
          `Layout ${keyboardConfig.layout} does not exits.\nCreate an entry or use another layout in you config.yaml`,
        );
      }

      device.listen();
      device.grab();

      const getActiveLayer = () => {
        const activeLayers = Object.entries(layerState)
          .map(([layerName, state]) => layerName && state && layerName)
          .filter((layerName) => !!layerName);
        return [keyboardConfig.layout, ...activeLayers];
      };
      let compiledKeymap = compileKeymap(this.config, getActiveLayer());
      let skipNextSync = false;

      device.onEvent((event) => {
        const type = eventTypes[event.type];
        const linuxKeyNames = type.events[event.code];
        if (type.name === 'EV_KEY') {
          const keyNames = new Set<string>();
          const currentKeymaps: SimpleKeymap[] = [];

          const visitedKeys = new Set<string>();
          const visitStack = [...linuxKeyNames];
          let currentKey: string;
          while ((currentKey = visitStack.shift())) {
            keyNames.add(currentKey);
            visitedKeys.add(currentKey);
            const keyDefinition = compiledKeymap[currentKey];
            if (!keyDefinition) continue;
            for (const alias of keyDefinition.aliases) {
              if (!visitedKeys.has(alias)) {
                visitStack.push(alias);
              }
            }
            currentKeymaps.push(...keyDefinition.keymaps);
          }

          for (const keyName of keyNames) {
            keyStates[keyName] = !!event.value;
          }

          if (event.value !== KeyChangeState.REPEAT) {
            console.log('---');
            for (const [key, state] of Object.entries(keyStates)) {
              if (state) console.log(`key ${key}`, true);
            }
          }

          let commandFound = false;
          if (event.value === KeyChangeState.RELEASE) {
            const releaseCodes = remapToRelease[event.code];
            if (releaseCodes) {
              for (const code of releaseCodes) {
                const nevEvent: NevEvent = {
                  type: constants.EV_KEY,
                  code: code,
                  value: KeyChangeState.RELEASE,
                };
                this.uinput.write(nevEvent);
                this.uinput.sync();
              }
            }
            remapToRelease[event.code] = undefined;
          }
          for (const keymap of currentKeymaps) {
            if (keymap.commands.length) {
              const allModifiersPressed = keymap.modifiers.every((m) => keyStates[m]);
              for (const command of keymap.commands) {
                // check if command is coniere as a key remapping
                if (event.value !== KeyChangeState.REPEAT) {
                  console.log('command:', command);
                }
                let match: RegExpMatchArray;
                // Check if we remap the key
                if (allModifiersPressed && command.match(/^\s*\w+\s*$/)) {
                  commandFound = true;
                  const key = command.trim();
                  // const keyName = eventTypes
                  console.log('Remap key to ', key);
                  const remappedCode = constants[command.trim().toUpperCase()];
                  const nevEvent = {
                    type: constants['EV_KEY'],
                    code: remappedCode,
                    value: !allModifiersPressed ? 0 : event.value,
                  };
                  remapToRelease[event.code] = remapToRelease[event.code] || new Set();
                  remapToRelease[event.code].add(remappedCode);
                  this.uinput.write(nevEvent);
                  this.uinput.sync();

                  // check if we want to run a shell command
                } else if (
                  (match = command.match(/^\s*>(.*)/)) &&
                  (event.value === KeyChangeState.PRESS || event.value === KeyChangeState.REPEAT) &&
                  allModifiersPressed
                ) {
                  commandFound = true;
                  const shellCommand = match[1];
                  exec(shellCommand, { uid: execUID, gid: execGID });

                  // check if we want to activate/deactivate a layer
                } else if ((match = command.match(/^\s*#(.*)/))) {
                  commandFound = true;
                  if (event.value === KeyChangeState.REPEAT) continue;
                  const layerName = match[1].trim();
                  layerState[layerName] = !!event.value && allModifiersPressed;
                  compiledKeymap = compileKeymap(this.config, getActiveLayer());
                }
              }
              break;
            }
          }
          if (!commandFound) {
            this.uinput.write(event);
            this.uinput.sync();
          }
          skipNextSync = true;
        } else {
          console.log('skipNextSync:', skipNextSync);
          console.log('type.name:', type.name);
          if (type.name === 'EV_SYNC') {
            if (!skipNextSync) this.uinput.write(event);
          } else {
            this.uinput.write(event);
          }
          skipNextSync = false;
        }
      });
    }
  }
  async unbind() {
    for (const device of this.loadedDevices) {
      for (const [key, state] of Object.entries(keyStates)) {
        if (state === true) {
          const code = constants[key];
          if (code) {
            this.uinput.write({
              type: constants.EV_KEY,
              code: code,
              value: KeyChangeState.RELEASE,
            });
            this.uinput.sync();
          }
        }
      }
      device.ungrab();
      device.removeAllListeners();
    }
    this.loadedDevices = [];
  }

  listenConfigChange() {
    console.log('Listening change for:', configFilePath);
    fs.watch(configFilePath, () => {
      console.log('Config changed, rebinding...');
      this.unbind();
      this.config = yaml.safeLoad(fs.readFileSync(configFilePath, 'utf-8')) as Config;
      console.log('config', this.config);
      if (this.config) this.bind();

      console.log('Rebinding done.');
    });
  }

  /**
   * Insure the config is properly defined.
   */
  validateConfig() {
    throw new Error('Implement me.');
  }
}

(async () => {
  const remapper = new Remapper();
  await remapper.start();
})();
