'use strict';

/*
 * Created with @iobroker/create-adapter v1.33.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const mqtt = require('mqtt');
const modbus = require("modbus-stream");
const Parser = require("binary-parser-encoder").Parser;
const schedule = require('node-schedule');
var mqttClient;
var me;

var  div10 = function(i) {
        return i / 10
}

var div100 = function(i) {
        return i / 100
}

const Solis4GParser = {
    InputRegister() {  return new Parser()
        .uint16be("ac_power")
        .seek(2)
        .uint16be("dc_power")
        .uint32be("total_energy")
        .seek(2)
        .uint16be("month_energy")
        .uint16be("lastmonth_energy")
        .seek(2)
        .uint16be("today_energy", { formatter: div10 })
        .uint16be("yesterday_energy", { formatter: div10 })
        .uint32be("year_energy")
        .uint32be("lastyear_energy")
        .seek(2)
        .uint16be("dc_voltage_1", { formatter: div10 })
        .uint16be("dc_current_1", { formatter: div10 })
        .uint16be("dc_voltage_2", { formatter: div10 })
        .uint16be("dc_current_2", { formatter: div10 })
        .seek(20)
        .uint16be("ac_voltage", { formatter: div10 })
        .uint16be("ac_current", { formatter: div10 })
        .seek(8)
        .uint16be("inverter_temperature", { formatter: div10 })
        .uint16be("ac_frequency", { formatter: div100 })
   }
}


class Sunny5Logger extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: 'sunny5logger',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		// this.on('objectChange', this.onObjectChange.bind(this));
		// this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
		me = this;
	}

	initMqtt(mqttServer) {
		mqttClient  = mqtt.connect('mqtt://' + mqttServer, { connectTimeout: 5*1000 })

		mqttClient.on('error', function (err) {
			me.log.error('Error connecting to MQTT broker');
			me.mqttConnected = false;
			me.setState('info.connection', false, true);
			me.setState('mqttConnected', false, true);
			mqttClient.publish(me.name + '/' + me.instance + '/mqttConnected', 'false');
		})

		mqttClient.on('connect', function () {
			me.log.info('Connected to MQTT broker: ' + mqttServer);
			me.mqttConnected = true;
			me.setState('info.connection', true, true);
			me.setState('mqttConnected', true, true);
			mqttClient.publish(me.name + '/' + me.instance + '/mqttConnected', 'true');
			//set default values
			mqttClient.publish(me.name + '/' + me.instance + '/inverter', me.config.inverter);
			mqttClient.publish(me.name + '/' + me.instance + '/updated', Date.now() + '');
		})
	}


	initSunny5Inverter() {
		mqttClient.subscribe('sunny5/#', {qos:1});

		//handle incoming mqtt messages (set)
		mqttClient.on('message', async function (topic, message) {
			// message is Buffer
			let msg = message.toString();
			let newtopic = topic.replace('sunny5/','');

			switch (newtopic) {
				case 'pv_energy':
					//me.log.info('MQTT message ' + newtopic + ' ' + msg);
					mqttClient.publish(me.name + '/' + me.instance + '/acPower', msg);
					mqttClient.publish(me.name + '/' + me.instance + '/dcPower', msg);
					break;
				case 'consumption':
					mqttClient.publish(me.name + '/' + me.instance + '/acConsumption', msg);
					break;
				case 'grid':
					mqttClient.publish(me.name + '/' + me.instance + '/gridMeter', msg);
					break;
			}

			mqttClient.publish(me.name + '/' + me.instance + '/updated', Date.now() + '');
		})
	}

	initSolis4GInverter(modbusDevice) {
		//mqttClient.subscribe('sunny5logger/#', {qos:1});

		modbus.serial.connect(modbusDevice, {
			baudRate : 9600,
			dataBits : 8,
			stopBits : 1,
			parity   : "even",
			debug    : "sunny5logger"
		}, (err, connection) => {
			me.modbusClient = connection;

			if (!err) {
				me.modbusConnected = true;
				me.setState('modbusConnected', true, true);
				mqttClient.publish(me.name + '/' + me.instance + '/modbusConnected', 'true');
				me.log.info('Connected to serial modbus device: ' + modbusDevice);

				me.schedule1S = schedule.scheduleJob('*/1 * * * * *', this.onSolisTicker.bind(this));
			}
			else {
				me.modbusConnected = false;
				me.setState('modbusConnected', false, true);
				mqttClient.publish(me.name + '/' + me.instance + '/modbusConnected', 'false');
				me.log.error('Error opening a serial modbus connection: ' + modbusDevice);
				return;
			}
		});
	}

	onSolisTicker() {
		this.readSolis4GInverter(me.modbusClient, me.modbusConnected);
	}

	readSolis4GInverter(connection,  modbusConnected) {
		if (!modbusConnected) return;

		connection.readInputRegisters({ address: 3005, quantity: 50, extra: { unitId: this.config.ModbusAddress } }, (err, res) => {
			if (err) return;
 
			let buf = Buffer.concat(res.response.data)
			let registers = Solis4GParser.InputRegister().parse(buf);
 
			Object.keys(registers).forEach(key => {
				let mqttKey = key.replace("_", "");
				let mqttValue = registers[key] + '';
				mqttClient.publish(me.name + '/' + me.instance + '/' + mqttKey, mqttValue);
				me.setState(key, registers[key], true);
			});
			mqttClient.publish(me.name + '/' + me.instance + '/updated', Date.now() + '');
		 })
 
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		/*
		For every state in the system there has to be also an object of type state
		Here a simple template for a boolean variable named "testVariable"
		Because every adapter instance uses its own unique namespace variable names can't collide with other adapters variables
		*/

		let states = {
			mqttServer: this.config.MqttServer,
			mqttConnected: 'false',
			modbusConnected: 'false',
			acPower: 0,
			dcPower: 0,
			totalEnergy: 0,
			monthEnergy: 0,
			lastmonthEnergy: 0,
			todayEnergy: 0,
			yesterdayEnergy: 0,
			yearEnergy: 0,
			lastyearEnergy: 0,
			dcVoltage1: 0,
			dcCurrent1: 0,
			dcVoltage2: 0,
			dcVurrent2: 0,
			acVoltage: 0,
			acCurrent: 0,
			inverterTemperature: 0,
			acFrequency: 0
		}
		  
		Object.keys(states).forEach(async key => {
			await this.setObjectNotExistsAsync(key, {
				type: 'state',
				common: {
					type: 'mixed',
					read: true,
					write: false,
				},
				native: {},
			});
			this.setState(key, states[key], true);
		});

		this.mqttConnected = false;
		this.modbusConnected = false;
		this.setState('info.connection', false, true);

		this.initMqtt(this.config.MqttServer);

		if (this.config.inverter === 'sunny5') this.initSunny5Inverter();
		if (this.config.inverter === 'solis4g') this.initSolis4GInverter(this.config.ModbusDevice);

		// In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
		// this.subscribeStates('lights.*');
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);

			callback();
		} catch (e) {
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === 'object' && obj.message) {
	// 		if (obj.command === 'send') {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info('send command');

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
	// 		}
	// 	}
	// }

}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Sunny5Logger(options);
} else {
	// otherwise start the instance directly
	new Sunny5Logger();
}