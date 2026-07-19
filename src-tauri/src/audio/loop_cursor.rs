use crate::error::AppError;

/// An end-exclusive source-frame range used for sample-counted looping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoopRange {
    pub start: u64,
    pub end: u64,
}

impl LoopRange {
    pub fn new(start: u64, end: u64) -> Result<Self, AppError> {
        if end <= start {
            return Err(AppError::Audio(
                "Loop end must be later than start".to_owned(),
            ));
        }
        Ok(Self { start, end })
    }

    /// Rounds integer millisecond boundaries to the nearest source PCM frame.
    pub fn from_milliseconds(
        start_ms: u64,
        end_ms: u64,
        sample_rate: u32,
    ) -> Result<Self, AppError> {
        if sample_rate == 0 {
            return Err(AppError::Audio(
                "Loop sample rate must be greater than zero".to_owned(),
            ));
        }

        let to_frame = |milliseconds: u64| {
            let rounded = (u128::from(milliseconds) * u128::from(sample_rate) + 500) / 1_000;
            u64::try_from(rounded).map_err(|_| {
                AppError::Audio("Loop millisecond boundary exceeds source frame range".to_owned())
            })
        };

        Self::new(to_frame(start_ms)?, to_frame(end_ms)?)
    }
}

/// Deterministic source-frame cursor. A loop is applied before returning each frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoopCursor {
    position: u64,
    range: Option<LoopRange>,
}

impl LoopCursor {
    pub const fn new(position: u64, range: Option<LoopRange>) -> Self {
        Self { position, range }
    }

    pub const fn position(&self) -> u64 {
        self.position
    }

    pub const fn range(&self) -> Option<LoopRange> {
        self.range
    }

    pub fn set_position(&mut self, position: u64) {
        self.position = position;
    }

    pub fn set_range(&mut self, range: Option<LoopRange>) {
        self.range = range;
    }

    pub fn take(&mut self) -> u64 {
        if let Some(range) = self.range {
            if self.position >= range.end {
                self.position = range.start;
            }
        }

        let current = self.position;
        self.position = self.position.saturating_add(1);
        current
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_end_exclusive_to_the_exact_start_frame() {
        let mut cursor = LoopCursor::new(94, Some(LoopRange::new(48, 96).unwrap()));

        let frames = (0..5).map(|_| cursor.take()).collect::<Vec<_>>();

        assert_eq!(frames, vec![94, 95, 48, 49, 50]);
    }

    #[test]
    fn progresses_without_wrapping_when_looping_is_disabled() {
        let mut cursor = LoopCursor::new(7, None);

        assert_eq!(
            (0..3).map(|_| cursor.take()).collect::<Vec<_>>(),
            vec![7, 8, 9]
        );
    }

    #[test]
    fn wraps_on_the_next_take_when_a_new_range_ends_at_the_current_position() {
        let mut cursor = LoopCursor::new(30, None);
        cursor.set_range(Some(LoopRange::new(12, 30).unwrap()));

        assert_eq!(cursor.take(), 12);
        assert_eq!(cursor.take(), 13);
    }

    #[test]
    fn preserves_a_position_before_the_start_until_it_reaches_the_end() {
        let mut cursor = LoopCursor::new(8, Some(LoopRange::new(10, 12).unwrap()));

        assert_eq!(
            (0..6).map(|_| cursor.take()).collect::<Vec<_>>(),
            vec![8, 9, 10, 11, 10, 11]
        );
    }

    #[test]
    fn converts_milliseconds_to_nearest_frames_within_one_millisecond() {
        for sample_rate in [44_100_u32, 48_000] {
            let start_ms = 1_234_u64;
            let end_ms = 2_345_u64;
            let range = LoopRange::from_milliseconds(start_ms, end_ms, sample_rate).unwrap();
            let frame_ms = |frame: u64| frame as f64 * 1_000.0 / sample_rate as f64;

            assert!((frame_ms(range.start) - start_ms as f64).abs() <= 1.0);
            assert!((frame_ms(range.end) - end_ms as f64).abs() <= 1.0);
        }
    }

    #[test]
    fn rejects_invalid_zero_rate_collapsed_and_overflowing_ranges() {
        assert!(LoopRange::new(10, 10).is_err());
        assert!(LoopRange::new(11, 10).is_err());
        assert!(LoopRange::from_milliseconds(1, 2, 0).is_err());
        assert!(LoopRange::from_milliseconds(0, 0, 48_000).is_err());
        assert!(LoopRange::from_milliseconds(u64::MAX, u64::MAX, u32::MAX).is_err());
    }
}
