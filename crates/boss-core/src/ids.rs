use serde::{Deserialize, Serialize};
use std::fmt;

macro_rules! id_type {
    ($name:ident, $prefix:literal) => {
        /// Opaque string id. New ids are `prefix_<uuid-v4>`; ids that come
        /// from an engine keep the engine's own text.
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn new() -> Self {
                Self(format!("{}_{}", $prefix, uuid::Uuid::new_v4().simple()))
            }
            pub fn from_raw(raw: impl Into<String>) -> Self {
                Self(raw.into())
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<&str> for $name {
            fn from(raw: &str) -> Self {
                Self(raw.to_owned())
            }
        }
        impl From<String> for $name {
            fn from(raw: String) -> Self {
                Self(raw)
            }
        }
    };
}

id_type!(ProjectId, "prj");
id_type!(ThreadId, "thr");
id_type!(MessageId, "msg");
id_type!(PartId, "prt");
id_type!(RoomId, "room");
id_type!(ParticipantId, "who");
id_type!(RequestId, "req");
id_type!(RunId, "run");
