import random
from dataclasses import dataclass

# === Timing constants (mirror TDMAProtocol.h) ===
TDMA_FRAME_PERIOD_MS = 20
TDMA_FRAME_PERIOD_US = TDMA_FRAME_PERIOD_MS * 1000
TDMA_BEACON_DURATION_US = 500
TDMA_FIRST_SLOT_GAP_US = 500
TDMA_GUARD_TIME_US = 2000
TDMA_SLOT_MIN_WIDTH_US = 2500
TDMA_SENSOR_DATA_SIZE = 25
TDMA_DATA_HEADER_SIZE = 8
TDMA_SAMPLES_PER_FRAME = 4

# Pipelined architecture: slot = fixed overhead + RF airtime (no I2C)
# RF model: 802.11g OFDM @ 6 Mbps (pinned via esp_now_set_peer_rate_config)
FIXED_OVERHEAD_US = 1500
INTER_SLOT_GAP_US = 100

# 802.11g OFDM constants
OFDM_PREAMBLE_US = 20  # OFDM preamble + PLCP
OFDM_N_DBPS = 24  # Data bits per symbol at 6 Mbps
OFDM_SYMBOL_US = 4  # OFDM symbol duration
OFDM_SIFS_US = 10
OFDM_ACK_US = 44  # 20µs preamble + 24µs (14-byte ACK at 6 Mbps)
FRAME_OVERHEAD_BYTES = 38  # MAC(24) + vendor(10) + FCS(4)

# Stress parameters
RANDOM_DISTRIBUTIONS = 1000
PACKET_LOSS_PROB = 0.10  # 10% beacon loss
FREEWHEEL_FRAMES = 2  # allow up to 2 missed beacons
MAX_NODES = 8
MAX_TOTAL_SENSORS = 16


@dataclass
class Result:
    total_sensors: int
    node_count: int
    schedule_ok_rate: float
    avg_frame_us: float
    max_frame_us: float
    est_success_rate: float


def calculate_slot_width(sensor_count: int) -> int:
    if sensor_count <= 0:
        return 0

    payload_bytes = (
        TDMA_DATA_HEADER_SIZE
        + (TDMA_SAMPLES_PER_FRAME * sensor_count * TDMA_SENSOR_DATA_SIZE)
        + 1
    )

    # 802.11g OFDM @ 6 Mbps airtime calculation
    # OFDM symbols: ceil((SERVICE(16) + TAIL(6) + 8*(overhead+payload)) / N_DBPS)
    ofdm_bits = 326 + 8 * payload_bytes  # 22 + 8*38 + 8*payload = 326 + 8*payload
    ofdm_syms = (ofdm_bits + OFDM_N_DBPS - 1) // OFDM_N_DBPS  # ceil division
    data_frame_us = OFDM_PREAMBLE_US + OFDM_SYMBOL_US * ofdm_syms
    airtime_us = data_frame_us + OFDM_SIFS_US + OFDM_ACK_US

    total_us = FIXED_OVERHEAD_US + airtime_us

    if total_us < TDMA_SLOT_MIN_WIDTH_US:
        total_us = TDMA_SLOT_MIN_WIDTH_US

    if total_us > 0xFFFF:
        total_us = 0xFFFF

    return int(total_us)


def calculate_frame_time(sensor_counts):
    if not sensor_counts:
        return TDMA_BEACON_DURATION_US

    total_slot_time = sum(calculate_slot_width(s) for s in sensor_counts)
    frame_time = (
        TDMA_BEACON_DURATION_US
        + TDMA_FIRST_SLOT_GAP_US
        + total_slot_time
        + (len(sensor_counts) - 1) * INTER_SLOT_GAP_US
        + TDMA_GUARD_TIME_US
    )
    return frame_time


def random_partition(total, parts):
    cuts = sorted(random.sample(range(1, total), parts - 1))
    counts = []
    prev = 0
    for c in cuts:
        counts.append(c - prev)
        prev = c
    counts.append(total - prev)
    return counts


def estimated_success_rate(schedule_ok: float) -> float:
    # Probability of more than FREEWHEEL_FRAMES consecutive losses
    # For independent losses, p^(FREEWHEEL_FRAMES + 1)
    drop_prob = PACKET_LOSS_PROB ** (FREEWHEEL_FRAMES + 1)
    beacon_ok = 1.0 - drop_prob
    return schedule_ok * beacon_ok


def run():
    results = []

    for total in range(1, MAX_TOTAL_SENSORS + 1):
        for nodes in range(1, min(MAX_NODES, total) + 1):
            ok_count = 0
            frame_sum = 0
            frame_max = 0

            for _ in range(RANDOM_DISTRIBUTIONS):
                counts = random_partition(total, nodes)
                frame_us = calculate_frame_time(counts)
                frame_sum += frame_us
                frame_max = max(frame_max, frame_us)
                if frame_us <= TDMA_FRAME_PERIOD_US:
                    ok_count += 1

            schedule_ok = ok_count / RANDOM_DISTRIBUTIONS
            avg_frame = frame_sum / RANDOM_DISTRIBUTIONS
            est_success = estimated_success_rate(schedule_ok)

            results.append(
                Result(
                    total_sensors=total,
                    node_count=nodes,
                    schedule_ok_rate=schedule_ok,
                    avg_frame_us=avg_frame,
                    max_frame_us=frame_max,
                    est_success_rate=est_success,
                )
            )

    print("TDMA Stress Test Summary")
    print("Assumptions:")
    print(f"- Beacon loss probability: {PACKET_LOSS_PROB:.2f}")
    print(f"- Freewheel frames: {FREEWHEEL_FRAMES}")
    print(f"- Frame period: {TDMA_FRAME_PERIOD_US} us")
    print()

    print("total\tnodes\tsched_ok\tavg_frame_us\tmax_frame_us\test_success")
    for r in results:
        print(
            f"{r.total_sensors}\t{r.node_count}\t"
            f"{r.schedule_ok_rate:.2f}\t{r.avg_frame_us:.0f}\t"
            f"{r.max_frame_us:.0f}\t{r.est_success_rate:.2f}"
        )

    # Identify configurations that meet target success
    print("\nConfigs meeting >=0.99 estimated success:")
    for r in results:
        if r.est_success_rate >= 0.99:
            print(
                f"- total={r.total_sensors}, nodes={r.node_count}, avg={r.avg_frame_us:.0f}us, max={r.max_frame_us:.0f}us"
            )


if __name__ == "__main__":
    random.seed(1337)
    run()
