import pymcprotocol
import time
import os
import json
import threading
import socket
from datetime import datetime, timezone, timedelta
from collections import deque

# set timeout to prevent socket freezing when LAN connection is abruptly dropped
socket.setdefaulttimeout(3.0)


BASE_DIR = r"D:\ABR_Data"
JSON_PATH = os.path.join(BASE_DIR, "ABR.config.json")

def get_utc_date_str():
    """คืนค่า string วันที่ UTC ปัจจุบัน เช่น '2026_03_30'"""
    return datetime.now(timezone.utc).strftime("%Y_%m_%d")

def log_to_dat(machine_name, folder, message, custom_utc=None, custom_local=None):
    """บันทึกลงไฟล์ตามวัน UTC เปลี่ยนวันจะขึ้นไฟล์ใหม่อัตโนมัติ โดยแยกห้องตามชื่อ PLC (machine_name)"""
    date_str = get_utc_date_str()
    # เพิ่ม machine_name เข้าไปใน path ชั้นแรก
    dir_path = os.path.join(BASE_DIR, machine_name, folder)
    os.makedirs(dir_path, exist_ok=True)
    filepath = os.path.join(dir_path, f"{date_str}.dat")
    
    timestamp_utc = custom_utc if custom_utc else datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    timestamp_local = custom_local if custom_local else datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    with open(filepath, mode='a', encoding='utf-8') as f:
        f.write(f"{timestamp_utc};{timestamp_local};{message}\n")

def load_tags_from_json():
    """อ่านคอนฟิก Tags ทั้งหมดจากไฟล์ JSON"""
    if not os.path.exists(JSON_PATH):
        raise FileNotFoundError(f"ไม่พบไฟล์คอนฟิก {JSON_PATH}")
    with open(JSON_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def load_state(machine_name):
    state_path = os.path.join(BASE_DIR, machine_name, "state.json")
    if os.path.exists(state_path):
        try:
            with open(state_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def save_state(machine_name, state_dict):
    state_path = os.path.join(BASE_DIR, machine_name, "state.json")
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    try:
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump(state_dict, f, indent=4)
    except Exception:
        pass

def get_last_total_from_dat(machine_name, date_str):
    folder = "output"
    dir_path = os.path.join(BASE_DIR, machine_name, folder)
    filepath = os.path.join(dir_path, f"{date_str}.dat")
    
    for attempt in range(3):
        if not os.path.exists(filepath):
            return None
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                # อ่านเจาะจงเฉพาะ 50 บรรทัดสุดท้ายเพื่อประหยัด RAM สกัดปัญหาไฟล์ใหญ่
                lines = list(deque(f, 50))
                for i in range(len(lines) - 1, -1, -1):
                    line = lines[i].strip()
                    if line:
                        parts = line.split(";")
                        if len(parts) >= 4:
                            return int(parts[3]) # คอลัมน์ที่ 4 คือ calc_t 
                return None
        except PermissionError:
            time.sleep(0.1) # โดน Lock ให้รอเสี้ยววิแล้วลองใหม่
        except Exception as e:
            return None
            
    return None

def run_plc_thread(plc_config, tags):
    """ฟังก์ชันสำหรับแต่ละ Thread ของ PLC (ทำงานคูขนานกัน 1 เครื่อง ต่อ 1 Thread)"""
    machine_name = plc_config.get("name", "Unknown_Machine")
    plc_ip = plc_config.get("ip")
    plc_port = plc_config.get("port")
    # Per-machine tags override: ถ้า plc_config มี "tags" ให้ merge ทับ global tags เฉพาะ key ที่กำหนด
    if "tags" in plc_config:
        tags = {**tags, **plc_config["tags"]}
    connection_lost_status = "Signal_Lost"
    
    # === โหลด State ล่าสุดจากไฟล์ เพื่อกันข้อมูลหายตอนคอมดับ ===
    loaded_state = load_state(machine_name)
    
    prev_model = loaded_state.get("prev_model", None)
    prev_total = loaded_state.get("prev_total", None)
    prev_ok = loaded_state.get("prev_ok", None)
    prev_ng = loaded_state.get("prev_ng", None)
    last_logged_status = loaded_state.get("last_logged_status", "")
    last_logged_alarm = loaded_state.get("last_logged_alarm", "")
    ct_stats = loaded_state.get("ct_stats", {})       # เก็บสถิติแยกตามจำนวนชิ้น เช่น "1": {"avg": 10.0, "count": 5}

    prev_status = {}
    prev_alarm = {}
    prev_station_ng = {dev: 0 for dev in tags["station_ng"].values()}
    pending_stations = {dev: False for dev in tags["station_ng"].values()}
    prev_output_time = None  # ไม่บันทึกลง state (reset ทุก connect ใหม่)
    last_event_ms = {}

    def get_unique_event_time(folder):
        now_utc = datetime.now(timezone.utc)
        now_local = datetime.now()
        now_ms = int(now_utc.timestamp() * 1000)
        previous_ms = last_event_ms.get(folder)

        if previous_ms is not None and now_ms <= previous_ms:
            now_ms = previous_ms + 1

        last_event_ms[folder] = now_ms
        adjusted_utc = datetime.fromtimestamp(now_ms / 1000, timezone.utc)
        offset_ms = now_ms - int(now_utc.timestamp() * 1000)
        adjusted_local = now_local + timedelta(milliseconds=offset_ms)

        utc_str = adjusted_utc.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        local_str = adjusted_local.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        return utc_str, local_str
    
    last_saved_state = {
        "prev_model": prev_model, "prev_total": prev_total,
        "prev_ok": prev_ok, "prev_ng": prev_ng,
        "last_logged_status": last_logged_status, "last_logged_alarm": last_logged_alarm,
        "ct_stats": ct_stats
    }

    def log_machine_status(status_str):
        nonlocal last_logged_status
        if not status_str or status_str == last_logged_status:
            return False

        status_utc, status_local = get_unique_event_time("machine_status")
        log_to_dat(machine_name, "machine_status", status_str, custom_utc=status_utc, custom_local=status_local)
        print(f"[{machine_name}] [STATUS] {status_str}")
        last_logged_status = status_str

        if last_logged_status != last_saved_state.get("last_logged_status"):
            last_saved_state["last_logged_status"] = last_logged_status
            save_state(machine_name, last_saved_state)

        return True

    while True: # ลูปนอกสำหรับจัดการ Reconnect หรือ Auto-Recovery
        pymc3e = pymcprotocol.Type3E()
        try:
            print(f"[{machine_name}] กำลังพยายามเชื่อมต่อ {plc_ip}:{plc_port}...")
            pymc3e.connect(plc_ip, plc_port)
            print(f"[{machine_name}] เชื่อมต่อสำเร็จ! เริ่มดึงข้อมูลตามปกติ ✅")
            just_reconnected = True
            # ---------------------------------------------------------
            # [เพิ่มโค้ดส่วนนี้] บังคับให้ส่ง Status ล่าสุดทันทีเมื่อเริ่มรันหรือเชื่อมต่อใหม่
            prev_status.clear()
            last_logged_status = ""
            
            # (Option) หากต้องการให้ส่ง Alarm ปัจจุบันด้วย ให้เอาคอมเมนต์ 2 บรรทัดล่างออก
            # prev_alarm.clear() 
            # last_logged_alarm = ""
            
            # เก็บชั่วโมงล่าสุดไว้สำหรับทำ Hourly Heartbeat (และรับรองปัญหา Midnight Rollover)
            last_logged_hour = datetime.now(timezone.utc).hour
            
            while True: # ลูปในสำหรับดึงข้อมูลปกติทุกๆ 1 วินาที
                has_error = False
                
                # เช็คการเปลี่ยนชั่วโมง (Hourly Heartbeat & Midnight Rollover) เพื่อบังคับส่ง Status ยืนยันว่าเครื่องยังเดินอยู่
                current_hour = datetime.now(timezone.utc).hour
                if current_hour != last_logged_hour:
                    last_logged_hour = current_hour
                    prev_status.clear()
                    last_logged_status = ""
                    print(f"[{machine_name}] ⏱️ ขึ้นชั่วโมงใหม่ (Hourly Heartbeat) บังคับส่งสถานะซ้ำอีกครั้งเพื่อป้องกัน Gap")
                
                # --- 1. Model ---
                if tags["model"]:
                    try:
                        val = pymc3e.batchread_wordunits(headdevice=tags["model"], readsize=1)
                        if val is not None and len(val) > 0:
                            raw_model_str = str(val[0])
                            current_model = tags.get("model_map", {}).get(raw_model_str, raw_model_str)
                            
                            if prev_model is not None and current_model != prev_model:
                                log_to_dat(machine_name, "model", f"{current_model}")
                                print(f"[{machine_name}] [MODEL CHANGED] {current_model}")
                            prev_model = current_model
                            
                            if prev_model != last_saved_state.get("prev_model"):
                                last_saved_state["prev_model"] = prev_model
                                save_state(machine_name, last_saved_state)
                    except Exception as e:
                        has_error = True

                # --- 2. Station NG (L bits) ---
                if not has_error:
                    for comment, dev in tags["station_ng"].items():
                        try:
                            val = pymc3e.batchread_bitunits(headdevice=dev, readsize=1)
                            if val is not None and len(val) > 0:
                                current_l = val[0]
                                if current_l == 1 and prev_station_ng.get(dev, 0) == 0:
                                    pending_stations[dev] = True
                                    print(f"[{machine_name}] [{comment}] PENDING_BUFFER=TRUE รอ Total เปลี่ยน...")
                                prev_station_ng[dev] = current_l
                        except Exception as e:
                            has_error = True
                            break

                # --- 3. Output (Total, OK, NG) ---
                if not has_error:
                    try:
                        current_output = {}
                        for comment, dev in tags["output"].items():
                            val = pymc3e.batchread_wordunits(headdevice=dev, readsize=1)
                            if val is not None and len(val) > 0:
                                current_output[comment] = val[0]
                        
                        if "Total" in current_output and "OK" in current_output and "NG" in current_output:
                            curr_t = current_output["Total"]
                            curr_ok = current_output["OK"]
                            curr_ng = current_output["NG"]
                            
                            if prev_total is not None and curr_t != prev_total:
                                total_diff = 0
                                is_gap_recovery = just_reconnected
                                force_cycletime = False
                                
                                if just_reconnected:
                                    today_str = get_utc_date_str()
                                    today_last = get_last_total_from_dat(machine_name, today_str)
                                    
                                    if today_last is None:
                                        # Rule 1: No log today, look back 1 day
                                        yesterday_date = datetime.now(timezone.utc) - timedelta(days=1)
                                        yesterday_str = yesterday_date.strftime("%Y_%m_%d")
                                        yesterday_last = get_last_total_from_dat(machine_name, yesterday_str)
                                        
                                        if yesterday_last is not None:
                                            if curr_t > yesterday_last:
                                                total_diff = curr_t - yesterday_last
                                            elif curr_t < yesterday_last:
                                                total_diff = curr_t
                                            else:
                                                total_diff = 0
                                        else:
                                            # Fallback if both files are empty
                                            total_diff = curr_t if curr_t < prev_total else curr_t - prev_total
                                    else:
                                        # Rule 2 & 3: We have log for today
                                        if curr_t > today_last:
                                            total_diff = curr_t - today_last
                                        elif curr_t < today_last:
                                            total_diff = curr_t
                                        else:
                                            total_diff = 0
                                            
                                    force_cycletime = True
                                else:
                                    # Normal checking when program is running
                                    if curr_t < prev_total:
                                        # Counter reset manually during runtime
                                        total_diff = curr_t
                                        is_gap_recovery = True
                                    else:
                                        total_diff = curr_t - prev_total
                                        
                                if total_diff > 0:
                                    ok_diff = curr_ok - (prev_ok if prev_ok is not None else 0)
                                    ng_diff = curr_ng - (prev_ng if prev_ng is not None else 0)
                                    
                                    if curr_ok < (prev_ok if prev_ok is not None else 0): ok_diff = curr_ok
                                    if curr_ng < (prev_ng if prev_ng is not None else 0): ng_diff = curr_ng
                                    
                                    ng_needed = max(0, ng_diff)
                                    # Limit NG to total diff just in case
                                    if ng_needed > total_diff: ng_needed = total_diff
                                        
                                    ok_needed = total_diff - ng_needed
                                    running_ok = curr_ok - ok_needed
                                    running_ng = curr_ng - ng_needed
                                        
                                    model_val = prev_model if prev_model is not None else "-"
                                    
                                    # คำนวณ Cycle Time จาก Timestamp ระหว่าง 2 รอบที่ Total เปลี่ยน
                                    base_utc = datetime.now(timezone.utc)
                                    base_loc = datetime.now()

                                    ct_val = "-"
                                    diff_key = str(total_diff)
                                    if diff_key not in ct_stats:
                                        ct_stats[diff_key] = {"avg": None, "count": 0}
                                        
                                    stat = ct_stats[diff_key]
                                    current_avg = stat.get("avg")

                                    if prev_output_time is not None and not is_gap_recovery:
                                        elapsed = (base_utc - prev_output_time).total_seconds()
                                        if elapsed > 0:
                                            ct_per_unit = elapsed / total_diff
                                            
                                            is_downtime = False
                                            if current_avg is not None:
                                                # ถ้า CT ที่ได้ มากกว่า 2 เท่าของค่าเฉลี่ยของกรณีนี้ -> มี Downtime ปน
                                                if ct_per_unit > (2 * current_avg):
                                                    is_downtime = True
                                                    
                                            if not is_downtime:
                                                ct_val = f"{ct_per_unit:.2f}"
                                                # อัปเดต Cumulative Moving Average แยกตามจำนวนชิ้นที่ออก
                                                if current_avg is None:
                                                    stat["avg"] = ct_per_unit
                                                else:
                                                    stat["avg"] = ((current_avg * stat["count"]) + ct_per_unit) / (stat["count"] + 1)
                                                stat["count"] += 1
                                                
                                                last_saved_state.update({"ct_stats": ct_stats})
                                                save_state(machine_name, last_saved_state)
                                            else:
                                                # พบ Downtime, แจ้งเตือนและใช้ค่าเฉลี่ย
                                                print(f"[{machine_name}] ⚠️ มีแนวโน้ม Downtime (Total+{total_diff}) ช่วง {elapsed:.1f}s | CT เกินลิมิต (ได้ {ct_per_unit:.1f} > Max {current_avg*2:.1f})")
                                                if current_avg is not None:
                                                    ct_val = f"{current_avg:.2f}"
                                    else:
                                        # ไม่มี prev_output_time, gap_recovery 
                                        if current_avg is not None:
                                            ct_val = f"{current_avg:.2f}"
                                    
                                    # สร้างตัวเลข Timestamp โดยยึดเอา base_utc ของรอบนั้นๆ มาเป็น ID เพื่อให้ของผลิตพร้อมกันได้เลขเดียวกัน
                                    batch_timestamp_id = int(base_utc.timestamp() * 1000)
                                    
                                    for i in range(total_diff):
                                        # Determine if this unit is NG
                                        is_ng_unit = False
                                        if ng_needed > 0:
                                            is_ng_unit = True
                                            ng_needed -= 1
                                            running_ng += 1
                                        else:
                                            running_ok += 1
                                            
                                        sta_val = "OK"
                                        stb_val = "OK"
                                        if is_ng_unit:
                                            for c, dev in tags["station_ng"].items():
                                                if c.upper().endswith("A") and pending_stations.get(dev):
                                                    sta_val = "NG"
                                                if c.upper().endswith("B") and pending_stations.get(dev):
                                                    stb_val = "NG"
                                            
                                            # หากเป็นชิ้น NG แต่ไม่มีสถานีไหนแจ้งเตือน (เช่นกรณี Gap Recovery) 
                                            # ให้บังคับลงช่องแรก (A) เสมอ เพื่อไม่ให้สูญหาย
                                            if sta_val == "OK" and stb_val == "OK":
                                                sta_val = "NG"
                                        
                                        # --- แก้ไขการเติมเวลา: ใช้ Cycle Time เฉลี่ยแบบนับถอยหลัง ---
                                        # 1. ดึงค่าเฉลี่ยมาใช้ (ถ้าโปรแกรมเพิ่งรันครั้งแรก ยังไม่มีค่าเฉลี่ย ให้ใช้ 1.0 วินาทีเป็นค่าเริ่มต้น)
                                        ct_interval = current_avg if current_avg is not None else 2.5
                                        if is_gap_recovery and force_cycletime:
                                            ct_interval = 2.5
                                            ct_val = "2.50"
                                        elif ct_val == "-":
                                            ct_val = "2.50"

                                        # 2. คำนวณเวลาย้อนหลัง (เพื่อให้ชิ้นสุดท้าย = เวลาปัจจุบันพอดี)
                                        # ตัวอย่าง: ขาด 3 ชิ้น (total_diff=3), CT=10วิ
                                        # i=0 (ชิ้นแรก): ลบ 20 วิ
                                        # i=1 (ชิ้นสอง): ลบ 10 วิ
                                        # i=2 (ชิ้นสาม): ลบ 0 วิ (เวลาปัจจุบัน)
                                        seconds_to_subtract = ct_interval * (total_diff - 1 - i)

                                        utc_time = base_utc - timedelta(seconds=seconds_to_subtract)
                                        loc_time = base_loc - timedelta(seconds=seconds_to_subtract)
                                        
                                        utc_str = utc_time.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                                        loc_str = loc_time.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                                        
                                        # จำลองเลข Total ให้ค่อยๆ วิ่งทีละ 1 ตามลำดับ
                                        calc_t = curr_t - total_diff + i + 1
                                        message_data = f"{model_val};{calc_t};{running_ok};{running_ng};{sta_val};{stb_val};{ct_val};{batch_timestamp_id}"
                                        
                                        log_to_dat(machine_name, "output", message_data, custom_utc=utc_str, custom_local=loc_str)
                                        print(f"[{machine_name}] [OUTPUT] {utc_str};{loc_str};{message_data}")
                                        
                                # รีเซ็ต pending หลังเก็บบันทึก
                                for k in pending_stations:
                                    pending_stations[k] = False
                                prev_output_time = datetime.now(timezone.utc)  # อัปเดตเวลาสำหรับคำนวณ CT รอบถัดไป
                                    
                            prev_total = curr_t
                            prev_ok = curr_ok
                            prev_ng = curr_ng
                            just_reconnected = False
                            
                            # Save state ถ้าตัวแปรมีการเปลี่ยนแปลง (ป้องกันการบันทึกลงไฟล์รัวๆ)
                            if prev_total != last_saved_state.get("prev_total"):
                                last_saved_state.update({
                                    "prev_total": prev_total,
                                    "prev_ok": prev_ok,
                                    "prev_ng": prev_ng
                                })
                                save_state(machine_name, last_saved_state)
                    except Exception as e:
                        has_error = True

                # --- 4. Machine Status ---
                if not has_error:
                    current_status_values = {}
                    status_changed = False
                    logged_rising_status = False

                    for tag in tags["status"]:
                        try:
                            val = pymc3e.batchread_bitunits(headdevice=tag["device"], readsize=1)
                            if val is not None and len(val) > 0:
                                current_val = val[0]
                                previous_val = prev_status.get(tag["device"], 0)
                                current_status_values[tag["device"]] = current_val

                                if current_val != previous_val:
                                    status_changed = True

                                if current_val == 1 and previous_val == 0:
                                    status_str = f"{tag['comment']}"
                                    if status_str != last_logged_status:
                                        status_utc, status_local = get_unique_event_time("machine_status")
                                        log_to_dat(machine_name, "machine_status", status_str, custom_utc=status_utc, custom_local=status_local)
                                        print(f"[{machine_name}] [STATUS] {status_str}")
                                        last_logged_status = status_str
                                        logged_rising_status = True

                                        if last_logged_status != last_saved_state.get("last_logged_status"):
                                            last_saved_state["last_logged_status"] = last_logged_status
                                            save_state(machine_name, last_saved_state)
                                prev_status[tag["device"]] = current_val
                        except Exception as e:
                            has_error = True
                            break

                    if not has_error and status_changed and not logged_rising_status:
                        active_status = None
                        for tag in tags["status"]:
                            if current_status_values.get(tag["device"]) == 1:
                                active_status = f"{tag['comment']}"

                        if active_status and active_status != last_logged_status:
                            status_utc, status_local = get_unique_event_time("machine_status")
                            log_to_dat(machine_name, "machine_status", active_status, custom_utc=status_utc, custom_local=status_local)
                            print(f"[{machine_name}] [STATUS] {active_status}")
                            last_logged_status = active_status

                            if last_logged_status != last_saved_state.get("last_logged_status"):
                                last_saved_state["last_logged_status"] = last_logged_status
                                save_state(machine_name, last_saved_state)

                # --- 5. Machine Alarm ---
                if not has_error:
                    for tag in tags["alarm"]:
                        try:
                            val = pymc3e.batchread_bitunits(headdevice=tag["device"], readsize=1)
                            if val is not None and len(val) > 0:
                                current_val = val[0]
                                if current_val == 1 and prev_alarm.get(tag["device"], 0) == 0:
                                    alarm_str = f"{tag['comment']};{tag['device']}"

                                    alarm_utc, alarm_local = get_unique_event_time("machine_alarm")
                                    log_to_dat(machine_name, "machine_alarm", alarm_str, custom_utc=alarm_utc, custom_local=alarm_local)
                                    
                                    if tag['comment'] != "-":
                                        print(f"[{machine_name}] [ALARM] {tag['comment']}")
                                        
                                    last_logged_alarm = alarm_str
                                    if last_logged_alarm != last_saved_state.get("last_logged_alarm"):
                                        last_saved_state["last_logged_alarm"] = last_logged_alarm
                                        save_state(machine_name, last_saved_state)
                                prev_alarm[tag["device"]] = current_val
                        except Exception as e:
                            has_error = True
                            break

                # เมื่อเจอ Socket หลุด หรือ Error ใดๆ ให้ดีดออกจากลูปในเพื่อเข้ากระบวนการ Restart ในลูปนอก
                if has_error:
                    log_machine_status(connection_lost_status)
                    print(f"[{machine_name}] ⚠️ หลุดการเชื่อมต่อหรือข้อมูลเน็ตเวิร์กผิดพลาด!")
                    break 

                time.sleep(0.5)

        except Exception as e:
            log_machine_status(connection_lost_status)
            print(f"[{machine_name}] ❌ เชื่อมต่อล้มเหลว: {e}")
            
        finally:
            # ไม่ว่าจะหลุดจาก Error แบบไหน ต้องล้าง Socket เดิมทิ้งเสมอ ไม่งั้น PLC พัง
            try:
                pymc3e.close()
            except:
                pass
            print(f"[{machine_name}] ⏳ รอ 5 วินาทีก่อนพยายามเชื่อมต่อใหม่...")
            time.sleep(5)

def main():
    print("กำลังโหลด Tags และ Setting จาก JSON...")
    try:
        config_data = load_tags_from_json()
    except Exception as e:
        print(f"อ่านไฟล์ JSON ไม่สำเร็จ: {e}")
        return

    plcs = config_data.get("plcs", [])
    if not plcs:
        print("❌ ไม่พบการตั้งค่า 'plcs': [] (รายชื่อเครือข่าย PLC) ในไฟล์ Config.json")
        return
        
    print(f"พบเชื่อมโยง PLC ทั้งหมด {len(plcs)} เครื่อง เริ่มต้นระบบ Multi-Threading...\n" + "-"*40)
    
    threads = []
    # กระจาย Thread ให้แต่ละ PLC
    for plc in plcs:
        t = threading.Thread(target=run_plc_thread, args=(plc, config_data), daemon=True)
        t.start()
        threads.append(t)
        
    try:
        # ให้ Thread หลักมีชีวิตต่อไปเพื่อให้ Thread ย่อยทำงานได้
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n🛑 หยุดการทำงานโดยผู้ใช้ (กด Ctrl+C)")
        print("ปิดระบบเรียบร้อย")

if __name__ == "__main__":
    main()
