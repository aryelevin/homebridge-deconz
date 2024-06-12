// homebridge-deconz/lib/DeconzAccessory/DummySwitch.js
// Copyright© 2022-2024 Arye Levin. All rights reserved.
//
// Homebridge plugin for deCONZ.

'use strict'

const { AccessoryDelegate } = require('homebridge-lib')
const DeconzService = require('../DeconzService')

/** Delegate class for a HomeKit accessory, corresponding to a light device
  * or groups resource.
  * @extends AccessoryDelegate
  * @memberof AccessoryDelegate
  */
class JewishCalendarSensor extends AccessoryDelegate {
  /** Instantiate a delegate for an accessory corresponding to a device.
    * @param {DeconzPlatform} platform - The platform.
    */
  constructor (platform, jewishCalendarConfig) {
    super(platform, { name: jewishCalendarConfig.name, id: jewishCalendarConfig.name })

    this.lat = parseFloat(platform._configJson.homeLocationCoords.latitude);
    this.long = parseFloat(platform._configJson.homeLocationCoords.longitude);
    this.name = jewishCalendarConfig.name;

    this.il = jewishCalendarConfig.israel;
    this.sheminiatzeret_in_sukkot = jewishCalendarConfig.sheminiatzeret_in_sukkot;
    this.candlelighting = jewishCalendarConfig.candlelighting;
    this.havdalah = jewishCalendarConfig.havdalah;
    this.sefiratOmerCustom = jewishCalendarConfig.sefiratOmerCustom;
    this.threeWeeksCustom = jewishCalendarConfig.threeWeeksCustom;  

    this.HeDate = require('../HeDate');
    this.SunCalc = require('../suncalc');
    this.offset = jewishCalendarConfig.offset;

    this.services = {};
    this.services.Shabbat = new DeconzService.JewishCalendarSensor(this, {name: "Shabbat", subtype: "Shabbat"});
    this.services.YomTov = new DeconzService.JewishCalendarSensor(this, {name: "Yom Tov", subtype: "YomTov"});
    this.services.Kodesh = new DeconzService.JewishCalendarSensor(this, {name: "Kodesh", subtype: "Kodesh", primaryService: true});
    this.services.RoshHashana = new DeconzService.JewishCalendarSensor(this, {name: "Rosh Hashana", subtype: "RoshHashana"});
    this.services.YomKippur = new DeconzService.JewishCalendarSensor(this, {name: "Yom Kippur", subtype: "YomKippur"});
    this.services.Sukkot = new DeconzService.JewishCalendarSensor(this, {name: "Sukkot", subtype: "Sukkot"});
    this.services.SheminiAtzeret = new DeconzService.JewishCalendarSensor(this, {name: "Shemini Atzeret", subtype: "SheminiAtzeret"});
    this.services.Pesach = new DeconzService.JewishCalendarSensor(this, {name: "Pesach", subtype: "Pesach"});
    this.services.Shavuot = new DeconzService.JewishCalendarSensor(this, {name: "Shavuot", subtype: "Shavuot"});
    this.services.Chanukah = new DeconzService.JewishCalendarSensor(this, {name: "Chanukah", subtype: "Chanukah"});
    this.services.ThreeWeeks = new DeconzService.JewishCalendarSensor(this, {name: "Three Weeks", subtype: "ThreeWeeks"});
    this.services.Omer = new DeconzService.JewishCalendarSensor(this, {name: "Omer", subtype: "Omer"});
    this.services.SefiratOmer = new DeconzService.JewishCalendarSensor(this, {name: "Sefirat Omer", subtype: "SefiratOmer"});
    this.services.Mourning = new DeconzService.JewishCalendarSensor(this, {name: "Mourning", subtype: "Mourning"});

    // this.identify()

    this.updateJewishDay();
    this.updateSensors();
    setTimeout(this.updateLoop.bind(this), 30000);

    setImmediate(() => {
      this.debug('initialised')
      this.emit('initialised')
    })
  }


  updateSensors() {
    this.services.Shabbat.values.contact = this.isShabbat();
    this.services.YomTov.values.contact = this.isYomTov();
    this.services.Kodesh.values.contact = this.isKodesh();
    this.services.RoshHashana.values.contact = this.isRoshHashana();
    this.services.YomKippur.values.contact = this.isYomKippur();
    this.services.Sukkot.values.contact = this.isSukkot();
    this.services.SheminiAtzeret.values.contact = this.isSheminiAtzeret();
    this.services.Pesach.values.contact = this.isPesach();
    this.services.Shavuot.values.contact = this.isShavuot();
    this.services.Chanukah.values.contact = this.isChanukah();
    this.services.ThreeWeeks.values.contact = this.isThreeWeeks();
    this.services.Omer.values.contact = this.isOmer();
    this.services.SefiratOmer.values.contact = this.isSefiratOmer();
    this.services.Mourning.values.contact = this.isMourning();
  }

  updateJewishDay() {
    this.gDate = new Date();
    if ((typeof this.offset !== 'undefined') && (this.offset != 0)) {
      this.debug("Shifting the time by " + this.offset + " minutes.");
      this.gDate = new Date(this.gDate.getTime() + this.offset * 60000);
    }
    this.debug("Test date is " + this.gDate.toISOString());
    this.hDate = new this.HeDate(this.gDate);

    // Extremely weird bug in Suncalc has it calculate the wrong times at edges of the day. Workaround is to always check at noon
    var midday = new Date(this.gDate.getFullYear(), this.gDate.getMonth(), this.gDate.getDate(), 12, 0, 0, 0, 0);

    // For debugging, track them both
    this.debug("updateJewishDay():  today=" + this.gDate.toISOString());
    this.debug("updateJewishDay(): midday=" + midday.toISOString());


    var suntimes = this.SunCalc.getTimes(midday, this.lat, this.long);
    this.sunset = suntimes.sunsetStart;
    
    this.debug("Sunset Tonight: " + this.sunset.toLocaleString());
// Note, this is for programming. In non leap years, Adar1 and Adar2 are BOTH 5. Month is zero indexed.

    this.hebrewMonths = {'Tishri': 0, 'Heshvan': 1, 'Kislev': 2, 'Tevet': 3, 'Shevat': 4, 'Adar1': 5};
    var thisYear = this.hDate.getFullYear();
    this.hebrewMonths.Adar2 = new this.HeDate(thisYear + 1, -7).getMonth();
    this.hebrewMonths.Nisan = new this.HeDate(thisYear + 1, -6).getMonth();
    this.hebrewMonths.Iyar = new this.HeDate(thisYear + 1, -5).getMonth();
    this.hebrewMonths.Sivan = new this.HeDate(thisYear + 1, -4).getMonth();
    this.hebrewMonths.Tamuz = new this.HeDate(thisYear + 1, -3).getMonth();
    this.hebrewMonths.Av = new this.HeDate(thisYear + 1, -2).getMonth();
    this.hebrewMonths.Elul = new this.HeDate(thisYear + 1, -1).getMonth();

    this.debug("This Year's Hebrew Months: ");
    this.debug(JSON.stringify(this.hebrewMonths));
  }

  updateLoop() {
    var today = new Date();
/*    if (
      (this.gDate.getFullYear() != today.getFullYear()) ||
      (this.gDate.getMonth() != today.getMonth()) ||
      (this.gDate.getDate() != today.getDate())
    ) {
  */
        this.updateJewishDay();
/*
    }
*/
    this.updateSensors();
    setTimeout(this.updateLoop.bind(this), 30000); 
  }



  isShabbat() {
    var day = this.gDate.getDay();
    var candletime = new Date(this.sunset);
    candletime.setMinutes(this.sunset.getMinutes() - this.candlelighting);

    var havdalahtime = new Date(this.sunset);
    havdalahtime.setMinutes(this.sunset.getMinutes() + this.havdalah);    
    return (((5 == day) && (this.gDate > candletime)) || ((6 == day) && (this.gDate < havdalahtime)));
  }

  isRoshHashana() {
    // Because of year wraps, if it's Elul 29, we check candle lighting, otherwise, use normal DateRange
    if ((this.hDate.getMonth() == this.hebrewMonths.Elul)&& this.hDate.getDate () == 29) {
      var candletime = new Date(this.sunset);
      candletime.setMinutes(this.sunset.getMinutes() - this.candlelighting);
      return this.gDate > candletime;
    }
    return this._inHebrewHolidayDateRange({month: this.hebrewMonths.Tishri, date: 0}, {month: this.hebrewMonths.Tishri, date: 2});
  }
  isYomKippur() {
    return this._inHebrewHolidayDateRange({month: this.hebrewMonths.Tishri, date: 9}, {month: this.hebrewMonths.Tishri, date: 10});
  }
  isSukkot() {
    var begin = {month: this.hebrewMonths.Tishri, date: 14};
    var end = (!this.il && this.sheminiatzeret_in_sukkot) ? {month: this.hebrewMonths.Tishri, date: 22} : {month: this.hebrewMonths.Tishri, date: 21};
    return this._inHebrewHolidayDateRange(begin, end);
  }
  _isSukkotYomTov() {
    var begin = {month: this.hebrewMonths.Tishri, date: 14};
    var end = (this.il) ? {month: this.hebrewMonths.Tishri, date: 15} : {month: this.hebrewMonths.Tishri, date: 16};
    return this._inHebrewHolidayDateRange(begin, end);
  }
  isSheminiAtzeret() {
    var begin = {month: this.hebrewMonths.Tishri, date: 21};
    var end = (this.il) ? {month: this.hebrewMonths.Tishri, date: 22} : {month: this.hebrewMonths.Tishri, date: 23};
    return this._inHebrewHolidayDateRange(begin, end);
  }
  isPesach() {
    var begin = {month: this.hebrewMonths.Nisan, date: 14};
    var end = (this.il) ? {month: this.hebrewMonths.Nisan, date: 21} : {month: this.hebrewMonths.Nisan, date: 22};
    return this._inHebrewHolidayDateRange(begin, end);
  }
  isThreeWeeks() {
    var begin; // night before Erev 17th of Tamuz
    if (this.threeWeeksCustom == "Ashkenazi") {
      begin = {month: this.hebrewMonths.Tamuz, date: 16};
    } else if (this.threeWeeksCustom == "Sephardic") {
      begin = {month: this.hebrewMonths.Tamuz, date: 29};
    }
    var Av9 = new this.HeDate(this.hDate.getFullYear(), this.hebrewMonths.Av, 9);
    var endDate = (Av9.getDay() == 6) ? 11 : 10; // Includes day after Fast.
    var end = {month: this.hebrewMonths.Av, date: endDate };
    return this._inHebrewHolidayDateRange(begin, end);
  }

  _isPesachYomTov() {
    // Leap years can make Nisan's month number "bounce" so we check for it
    
    var begin = {month: this.hebrewMonths.Nisan, date: 14};
    var end = (this.il) ? {month: this.hebrewMonths.Nisan, date: 15} : {month: this.hebrewMonths.Nisan, date: 16};
    var firstDays = this._inHebrewHolidayDateRange(begin, end);
    begin = {month: this.hebrewMonths.Nisan, date: 20};
    end = (this.il) ? {month: this.hebrewMonths.Nisan, date: 21} : {month: this.hebrewMonths.Nisan, date: 22};
    var secondDays = this._inHebrewHolidayDateRange(begin, end);
    return firstDays || secondDays;
  }
  isOmer() {
    var begin = {month: this.hebrewMonths.Nisan, date: 15};
    var end = {month: this.hebrewMonths.Sivan, date: 6};
    return this._inHebrewHolidayDateRange(begin, end);
  }
  isSefiratOmer() {
    var begin = false;
    var end = false;
    if (this.sefiratOmerCustom == "Ashkenazi") {
      begin = {month: this.hebrewMonths.Nisan, date: 15};
      end = {month: this.hebrewMonths.Iyar, date: 18};
    } else if (this.sefiratOmerCustom == "Sephardic") {
      begin = {month: this.hebrewMonths.Nisan, date: 15};
      end = {month: this.hebrewMonths.Iyar, date: 19};
    } else if (this.sefiratOmerCustom == "Iyar") {
      begin = {month: this.hebrewMonths.Nisan, date: 29};
      end = {month: this.hebrewMonths.Sivan, date: 3};
    } else if (this.sefiratOmerCustom == "Iyar2") {
      begin = {month: this.hebrewMonths.Iyar, date: 2};
      end = {month: this.hebrewMonths.Sivan, date: 5};
    }
    if (begin && end) {
      return this._inHebrewHolidayDateRange(begin, end);
    }
    return false;
  }
  isMourning() { return this.isSefiratOmer() || this.isThreeWeeks();}

  isShavuot() {
    // Leap years can make Sivan's month number "bounce" so we check for it
    var begin = {month: this.hebrewMonths.Sivan, date: 5};
    var end = (this.il) ? {month: this.hebrewMonths.Sivan, date: 6} : {month: this.hebrewMonths.Sivan, date: 7};
    return this._inHebrewHolidayDateRange(begin, end);
  }
  isYomTov() {
    var holidays = this.isRoshHashana() || this.isYomKippur() || this._isSukkotYomTov() ||
         this.isSheminiAtzeret() || this._isPesachYomTov() || this.isShavuot();
    return holidays;
  }
  isKodesh() {
    return (this.isShabbat() || this.isYomTov());
  }

  isChanukah() {
    var ChanukahEnd = new this.HeDate(this.hDate.getFullYear(), 2, 32);

    var begin = {month: this.hebrewMonths.Kislev, date: 24 };
    var end = {month: ChanukahEnd.getMonth(), date: ChanukahEnd.getDate() };
    return this._inHebrewHolidayDateRange(begin, end);    
  }
  _inHebrewHolidayDateRange(erev, end) {
    // Assumes that all ranges are within the same Hebraic year. 
    // We COULD support wrap arounds, but it is only needed for Rosh Hashana
    // Handled there as a special case rule

    var candletime = new Date(this.sunset);
    candletime.setMinutes(this.sunset.getMinutes() - this.candlelighting);

    var havdalahtime = new Date(this.sunset);
    havdalahtime.setMinutes(this.sunset.getMinutes() + this.havdalah);    

    var todayHebrewMonth = this.hDate.getMonth();
    var todayHebrewDate = this.hDate.getDate();

    // Date should be in the format {month, date}
    if ((todayHebrewMonth == erev.month) && (todayHebrewDate == erev.date)) {
      // First Day -- true after sunset
      return (this.gDate > candletime);
    } else if ((todayHebrewMonth == end.month) && (todayHebrewDate == end.date)) {
      // Last Day -- true until sunset
      return (this.gDate < havdalahtime);
    } else if (
          ((todayHebrewMonth > erev.month) || (todayHebrewMonth == erev.month && todayHebrewDate > erev.date))
          &&
          ((todayHebrewMonth < end.month) || (todayHebrewMonth == end.month && todayHebrewDate < end.date))) {
      return true;
    } else {
      // Not in the middle
      return false;
    }
  }
}

module.exports = JewishCalendarSensor
