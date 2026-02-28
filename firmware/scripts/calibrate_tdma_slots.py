import serial
import time
import re
import statistics
import sys
import os

# Configuration
SERIAL_PORT = "COM5"  # Change to your QT Py COM port
BAUD_RATE = 115200
CALIBRATION_TIME = 30  # Seconds to gather data

# Storage for P99 readings
process_times = []
build_times = []
air_times = []


def parse_line(line):
    # Look for: [TIMING-P99] Process=1234 us, Build=50 us, AirTime=1500 us
    if "[TIMING-P99]" in line:
        # print(line) # Verbose
        match = re.search(r"Process=(\d+) us, Build=(\d+) us, AirTime=(\d+) us", line)
        if match:
            p = int(match.group(1))
            b = int(match.group(2))
            a = int(match.group(3))
            process_times.append(p)
            build_times.append(b)
            air_times.append(a)


file_mode = False
if len(sys.argv) > 1:
    filename = sys.argv[1]
    if os.path.exists(filename):
        print(f"Reading from file: {filename}")
        file_mode = True
        try:
            with open(filename, "r") as f:
                for line in f:
                    parse_line(line.strip())
        except Exception as e:
            print(f"Error reading file: {e}")
            exit(1)
    else:
        print(f"File not found: {filename}")
        exit(1)
else:
    print(f"Connecting to {SERIAL_PORT} for TDMA Calibration...")
    try:
        ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
    except Exception as e:
        print(f"Error opening serial port: {e}")
        exit(1)

    start_time = time.time()
    print(f"Gathering Timing Data for {CALIBRATION_TIME} seconds...")

    try:
        while time.time() - start_time < CALIBRATION_TIME:
            if ser.in_waiting:
                line = ser.readline().decode("utf-8", errors="ignore").strip()
                parse_line(line)
                if "[TIMING-P99]" in line:
                    print(line)
    except KeyboardInterrupt:
        print("Stopped by user")
    finally:
        ser.close()

if len(process_times) == 0:
    print(
        "No timing data received! Ensure firmware is flashed and node is running or log file contains [TIMING-P99] tags."
    )
    exit(1)

# Calculate P99 (Safest max)
p_max = max(process_times)
b_max = max(build_times)
a_max = max(air_times)

print("\n" + "=" * 40)
print("CALIBRATION RESULTS (WORST CASE)")
print("=" * 40)
print(f"Max Processing Time: {p_max} us")
print(f"Max Packet Build:    {b_max} us")
print(f"Max Airtime + ACK:   {a_max} us")

# Calculate Constants
try:
    if file_mode:
        # If running from file script (assumed non-interactive or pipe)
        # Try to read from stdin if provided, else default
        if not sys.stdin.isatty():
            # Piped input
            # Read all remaining stdin
            input_str = sys.stdin.read().strip()
            if input_str.isdigit():
                sensor_count = int(input_str)
            else:
                sensor_count = 6  # Default for analysis
        else:
            # Interactive but maybe stuck if not real tty? fallback
            # If we are here, we might be able to prompt
            try:
                sensor_count = int(
                    input("\nHow many sensors are active on this node? ")
                )
            except:
                sensor_count = 6
    else:
        sensor_count = int(input("\nHow many sensors are active on this node? "))
except:
    sensor_count = 6  # Fallback

measured_total = p_max + b_max + a_max
print(f"\nTotal Time Required for {sensor_count} sensors: {measured_total} us")

# Recommended Slot Width
rec_slot = measured_total + 500  # 500us safety margin
print(f"Recommended Slot Width: {rec_slot} us")

print("\nRECOMMENDED ACTIONS:")
print(
    f"1. If measured total exceeds calculateSlotWidth({sensor_count}) = {rec_slot} µs,"
)
print(f"   review the FIXED_OVERHEAD_US (currently 1500) in calculateSlotWidth().")
print(f"2. Run the full topology through calculateFrameTime() to verify 20ms budget.")
