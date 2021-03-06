//process.env.DEBUG = ""; // BraviaHost,HostBase";
process.env.DEBUG = "BraviaHost";
process.title = process.env.TITLE || "bravia-microservice";

const debug = require("debug")("BraviaHost"),
  Bravia = require("bravia"),
  HostBase = require("microservice-core/HostBase"),
  console = require("console"),
  chalk = require("chalk");

const request = require("superagent");

const POLL_TIME = 500;

const TOPIC_ROOT = process.env.TOPIC_ROOT || "bravia",
  MQTT_HOST = process.env.MQTT_HOST,
  BRAVIA_HOSTS = process.env.BRAVIA_HOSTS.split(",");

process.on("unhandledRejection", (reason /*, promise*/) => {
  console.log(chalk.red.bold("[PROCESS] Unhandled Promise Rejection"));
  console.log(chalk.red.bold("- - - - - - - - - - - - - - - - - - -"));
  console.log(reason);
  console.log(chalk.red.bold("- -"));
});

class BraviaHost extends HostBase {
  constructor(host) {
    super(MQTT_HOST, TOPIC_ROOT + "/" + host);
    debug("constructor", host);
    this.host = host;
    this.inputs = {};
    this.commandQueue = [];
    this.baseUrl = `http://${host}/sony/`;
    this.bravia = new Bravia(this.host);
    this.poll();
  }

  async getApplicationList() {
    const list = await this.bravia.appControl.invoke("getApplicationList"),
      state = {};

    for (let app of list) {
      state[app.title] = app;
    }
    this.state = {
      appsMap: state,
      appsList: list,
    };

    return state;
  }

  async launchApplication(title) {
    title = title.toLowerCase();
    for (const app of this.state.appsList) {
      if (app.title.toLowerCase() === title) {
        await this.bravia.appControl.invoke("setActiveApp", "1.0", {
          uri: app.uri,
        });
        return;
      }
    }
  }

  async getCodes() {
    if (!this.codes) {
      this.codesMap = {};
      try {
        this.codes = await this.bravia.getIRCCCodes();
        for (const code of this.codes) {
          this.codesMap[code.name.toUpperCase()] = code.name;
          // aliases
          this.codesMap["POWERON"] = "WakeUp";
        }
        //        this.codes.forEach(code => {
        //          debug(this.host, code);
        //        });
      } catch (e) {
        //        if (this.state && this.state.power) {
        debug(this.host, "getCodes exception1", e);
        this.state = { power: false, input: "OFF" };
        //        }
      }
    }
    if (!this.apps) {
      try {
        this.apps = await this.getApplicationList();
      } catch (e) {
        if (this.state && this.state.power) {
          debug(this.host, "getCodes exception2", e);
        }
      }
    }
  }

  async getVolume() {
    const volume = await this.bravia.audio.invoke("getVolumeInformation"),
      state = {};

    try {
      for (let vol of volume) {
        state[vol.target] = vol;
      }
    } catch (e) {
      if (this.state && this.state.power) {
        debug(this.host, "getVolume exception", e);
      }
    }
    return state;
  }

  async getPowerStatus() {
    try {
      var state = await this.bravia.system.invoke("getPowerStatus");
      return state;
    } catch (e) {
      debug(this.host, "getPowerStatus exception", e);
      return false;
    }
  }

  async getInputStatus() {
    try {
      var state = await this.bravia.avContent.invoke(
        "getCurrentExternalInputsStatus"
      );
      // console.log("inputStaus", state);
      return state;
    } catch (e) {
      // debug(this.host, "getInputStatus  exception", e);
      this.state = { input: "HDMI 1" };
      return false;
    }
  }

  async post(service, method, params) {
    params = params || [];
    const url = this.baseUrl + service,
      o = { method: method, params: params, id: 1, version: "1.0" };

    const res = await request
      .post(url)
      .set("ContentType", "application/json; charset=UFT-8")
      .set("X-Auth-PSK", "0000")
      .send(o);

    return JSON.parse(res.text);
  }

  async pollPower() {
    const ret = await this.post("system", "getPowerStatus"),
      power = ret.result[0].status === "active";
    this.state = {
      power: power,
    };
  }

  async pollInput() {
    const ret = await this.post("avContent", "getPlayingContentInfo");
    if (ret.error) {
      this.state = { input: "HDMI 1" };
      //    console.log(this.host, "ret", ret);
      //      this.state = {
      //        input: "none"
      //      };
    } else {
      // console.log(ret.result[0].title);
      this.state = {
        input: ret.result[0].title.replace(/\/.*$/, ""),
      };
    }
  }

  async getPlayingContentInfo() {
    //    console.log("getPlayingContentInfo");
    try {
      var state = await this.bravia.avContent.invoke("getPlayingContentInfo");
      return state;
    } catch (e) {
      debug(this.host, "getPlayingContentInfo  exception", e);
      return false;
    }
  }

  async poll() {
    let lastVolume = null;

    //    debug(this.host, "poll");
    while (1) {
      try {
        await this.getCodes();
        //        console.log("---");
        //        for (const code of this.codes) {
        //          console.log("code: ", code.name);
        //        }
        //        console.log("---");
        this.state = {
          codes: this.codes,
        };
      } catch (e) {
        debug(this.host, "getCodes exception", e);
      }

      await this.pollPower();
      //      try {
      //        const state = await this.getPowerStatus();
      //        this.state = {
      //          power: state.status === "active"
      //        };
      //      } catch (e) {
      //        debug(this.host, "poll exception", e);
      //      }

      try {
        const newVolume = await this.getVolume(),
          encoded = JSON.stringify(newVolume);

        if (lastVolume !== encoded) {
          this.state = {
            volume: await this.getVolume(),
          };
          lastVolume = encoded;
        }
      } catch (e) {
        if (this.state && this.state.power) {
          debug(this.host, "poll getVolume exception", e);
        }
      }

      //      try {
      //        const inputs = await this.getInputStatus();
      //        this.inputs = Object.assign(this.inputs, inputs);
      //        this.state = {
      //          inputs: this.inputs
      //        };
      //      } catch (e) {
      //        debug(this.host, "poll exception", e);
      //      }

      try {
        if (!this.state.power) {
          this.state = {
            input: "Off",
          };
        } else {
          await this.pollInput();
          /*
            try {
            const nowPlaying = await this.getPlayingContentInfo();
            let input = nowPlaying.title.toLowerCase().replace(/\s+/g, "");
            //          console.log("nowPlaying", input);

            //          if (input.indexOf("hdmi") === 0) {
            //            input = input.substr(0, 5);
            //          }
            //        console.log("input", input, nowPlaying.title);
            this.state = {
            input: input.title.replace(/\/.*$/, '')
            };
            }
            catch (e) {}
            //          this.state = {
            //            input: input
            //          };
            */
        }
      } catch (e) {
        debug(this.host, "poll exception", e);
      }

      await this.wait(POLL_TIME);
    }
  }

  async commandRunner() {
    let timer = setInterval(() => {
      if (this.codesMap.POWERON) {
        const command = this.commandQueue.shift();
        if (command) {
          const cmd = this.codesMap[command.toUpperCase()];
          if (cmd) {
            console.log("bravia send", this.host, cmd);
            this.bravia.send(cmd);
          }
        } else {
          clearInterval(timer);
          timer = null;
        }
      }
    }, 500);
  }

  async command(topic, command) {
    debug("command", command);
    if (command.startsWith("LAUNCH-")) {
      await this.launchApplication(command.substr(7));
      //      await this.bravia.appControl.invoke("setActiveApp", "1.0", {
      //        uri: command.substr(7)
      //      });
      //      debug(
      //        this.host,
      //        "getPlayingContentInfo",
      //        await this.bravia.avContent.invoke("getPlayingContentInfo", "1.0")
      //      );
      //      Promise.resolve();
    }
    command = command.toUpperCase();
    if (command === "POWERON") {
      this.commandQueue.push("WakeUp");
      this.commandRunner();
      //      this.bravia.send("WakeUp");
      return;
    }
    const cmd = this.codesMap[command.toUpperCase()];
    if (cmd) {
      switch (cmd.toUpperCase().replace(" ", "")) {
        case "HDMI1":
          this.state = { input: "HDMI 1" };
          break;
        case "HDMI2":
          this.state = { input: "HDMI 1" };
          break;
        case "HDMI3":
          this.state = { input: "HDMI 3" };
          break;
        case "HDMI4":
          this.state = { input: "HDMI 3" };
          break;
      }
      this.commandQueue.push(cmd);
      if (this.commandQueue.length < 2) {
        this.commandRunner();
      }

      //      return this.bravia.send(cmd);
    } else {
      console.log(this.host, "invalid command", command);
    }
  }
}

const tvs = {};

function main() {
  if (!MQTT_HOST) {
    console.log("ENV variable MQTT_HOST not found");
    process.exit(1);
  }
  if (!BRAVIA_HOSTS || !BRAVIA_HOSTS.length) {
    console.log("ENV variable BRAVIA_HOSTS not found");
    process.exit(1);
  }
  BRAVIA_HOSTS.forEach((host) => {
    tvs[host] = new BraviaHost(host);
  });
}

main();
