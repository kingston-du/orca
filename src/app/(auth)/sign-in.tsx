import { useState } from "react";
import { View, Text, TextInput, Pressable } from "react-native";

export default function SignInScreen() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState("none");


    return (
        <View>
            <TextInput
                placeholder="email"
                onChangeText={setEmail}
            />
            <TextInput
                placeholder="password"
                onChangeText={setPassword}
            />

        </View>
    );
}